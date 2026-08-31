import { failure, UpstreamError, toFailure } from "../utils/errors.js";
import { recordUpstream, type Upstream, type UpstreamOperation } from "../metrics/record.js";

/**
 * The only place in this codebase that speaks HTTP to an upstream service.
 *
 * Keeping the calls here is what makes an upstream contract change a
 * single-directory edit. A lint rule forbids `fetch` elsewhere under src/.
 */

/**
 * PROXY_URL is deliberately not honoured here.
 *
 * This client only ever talks to SearXNG and Crawl4AI, which sit on the same
 * compose network. Those two are the ones that reach the public internet, so
 * the relay belongs in their environment, not in ours - sending internal
 * container-to-container traffic through an external relay would be both
 * pointless and a way to leak the relay's existence into every request.
 *
 * See docker/compose.yaml, where PROXY_URL is passed to searxng and crawl4ai.
 */

export interface RequestOptions {
  /**
   * Which upstream this call is for, and what it is doing.
   *
   * Recorded so a slow tool can be split into "we were slow" and "we were
   * waiting". Subtracting this from the tool duration is the whole of the
   * latency-isolation story, and is why the upstreams' own metrics endpoints
   * are not scraped: they answer the same question from the other side, and
   * reaching them would put a credential into the collector's config.
   */
  readonly upstream?: Upstream;
  readonly operation?: UpstreamOperation;
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly token?: string;
  readonly timeoutMs?: number;
  /** Status codes to accept besides 2xx. */
  readonly expect?: readonly number[];
}

export interface UpstreamResponse<T> {
  readonly status: number;
  readonly body: T;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function request<T>(
  url: string,
  options: RequestOptions = {},
): Promise<UpstreamResponse<T>> {
  const { method = "GET", body, token, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const headers: Record<string, string> = { accept: "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  // `exactOptionalPropertyTypes` will not accept an explicit `undefined` for
  // `body`, so the key is added only when there is one.
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const started = process.hrtime.bigint();
  const elapsed = (): number => Number(process.hrtime.bigint() - started) / 1e9;
  const measure = (outcome: "success" | "failure"): void => {
    if (options.upstream && options.operation) {
      recordUpstream(options.upstream, options.operation, outcome, elapsed());
    }
  };

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    measure("failure");
    throw new UpstreamError(toFailure(error));
  }

  const ok =
    (response.status >= 200 && response.status < 300) ||
    (options.expect?.includes(response.status) ?? false);

  if (!ok) {
    measure("failure");
    const detail = await response.text().catch(() => "");
    throw new UpstreamError(
      failure(
        response.status === 401 || response.status === 403
          ? "upstreamUnavailable"
          : "httpError",
        `Upstream returned ${response.status}${detail ? `: ${detail.slice(0, 400)}` : ""}`,
        response.status,
      ),
    );
  }

  measure("success");

  let parsed: T;
  try {
    parsed = (await response.json()) as T;
  } catch {
    throw new UpstreamError(
      failure("upstreamUnavailable", "Upstream returned a body that is not JSON."),
    );
  }

  return { status: response.status, body: parsed };
}
