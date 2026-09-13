import { request } from "./http.js";
import { env } from "../utils/env.js";
import { failure, UpstreamError, type ToolFailure } from "../utils/errors.js";
import type { UpstreamOperation } from "../metrics/record.js";
import type { CrawlJob, FetchedDocument, JobState, PageLink } from "./types.js";

/**
 * Crawl4AI's HTTP API.
 *
 * Everything below was verified against a running Crawl4AI 0.9.2 container
 * (its own /openapi.json plus observed responses) rather than taken from the
 * documentation, which disagreed on several points.
 *
 * Note what is absent: no deep-crawl request. The server refuses
 * `deep_crawl_strategy` from any HTTP caller, so multi-level crawling is
 * sequenced a level at a time by the composition layer. This module only ever
 * asks for a flat list of URLs.
 *
 * Pages are read through `/crawl/stream`, never `/md` or `/crawl`. Those two
 * answer a bare 500 - detail withheld, only a correlation id - whenever the one
 * page asked for fails, so a target's 404 arrived here as a backend fault. The
 * stream answers 200 with a result per URL, status code and markdown included.
 */

interface RawMarkdown {
  readonly raw_markdown?: unknown;
  readonly fit_markdown?: unknown;
}

interface RawLink {
  readonly href?: unknown;
  readonly text?: unknown;
}

export interface RawCrawlResult {
  readonly url?: unknown;
  readonly redirected_url?: unknown;
  readonly success?: unknown;
  readonly status_code?: unknown;
  readonly markdown?: unknown;
  readonly links?: unknown;
  readonly metadata?: unknown;
  readonly error_message?: unknown;
}

interface RawCrawlResponse {
  readonly success?: unknown;
  readonly results?: unknown;
}

interface RawJobSubmit {
  readonly task_id?: unknown;
}

interface RawJobStatus {
  readonly task_id?: unknown;
  readonly status?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

/** Which markdown variant to trust first. */
export type MarkdownPreference = "raw" | "fit";

export interface CrawlOptions {
  /**
   * Ask for boilerplate-filtered markdown, as a single-page read promises.
   * Batch and crawl callers want every link and paragraph, so they leave it off.
   */
  readonly readable?: boolean;
  readonly operation?: UpstreamOperation;
}

const ANTIBOT_PREFIX = "Blocked by anti-bot protection:";

/**
 * Crawl4AI's structural heuristic fails any page under 5KB with fewer than 50
 * visible characters, whatever it answered - a 200 version file included. Only
 * the pattern tiers identify an actual block page. Upstream issue #2058.
 */
const CONTENT_VETO = `${ANTIBOT_PREFIX} Structural:`;

const STREAM_CONFIG = { stream: true } as const;

const READABLE_CONFIG = {
  stream: true,
  markdown_generator: {
    type: "DefaultMarkdownGenerator",
    params: { content_filter: { type: "PruningContentFilter", params: {} } },
  },
} as const;

function token(): string {
  return env().CRAWL4AI_API_TOKEN;
}

function base(path: string): string {
  return new URL(path, env().CRAWL4AI_URL).toString();
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function statusOf(raw: RawCrawlResult): number | null {
  return typeof raw.status_code === "number" ? raw.status_code : null;
}

/**
 * `markdown` is an object, not a string.
 *
 * Without a content filter `fit_markdown` comes back empty on plenty of
 * ordinary pages, so `raw_markdown` is the one to trust there. A readable read
 * asked for the filter, so it takes fit first and raw only when fit is empty.
 */
function markdownOf(value: unknown, prefer: MarkdownPreference): string | null {
  if (typeof value === "string") return value || null;
  if (value && typeof value === "object") {
    const m = value as RawMarkdown;
    const raw = str(m.raw_markdown);
    const fit = str(m.fit_markdown);
    return (prefer === "fit" ? fit || raw : raw || fit) || null;
  }
  return null;
}

/** A code fence around nothing is not content. */
function hasContent(markdown: string | null): boolean {
  return markdown !== null && /[^\s`]/.test(markdown);
}

function linksOf(value: unknown): FetchedDocument["links"] {
  if (!value || typeof value !== "object") return null;
  const v = value as { internal?: unknown; external?: unknown };
  const map = (list: unknown): PageLink[] => {
    if (!Array.isArray(list)) return [];
    return list.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const href = str((entry as RawLink).href);
      if (!href) return [];
      return [{ href, text: str((entry as RawLink).text) }];
    });
  };
  return { internal: map(v.internal), external: map(v.external) };
}

/** Turn an upstream per-URL failure into a reason the caller can act on. */
function resultFailure(raw: RawCrawlResult): ToolFailure {
  const status = statusOf(raw);
  const message = str(raw.error_message, "The page could not be fetched.");

  if (status !== null && status >= 400) {
    if (status === 403 || status === 429) {
      return failure("blocked", `The target refused automated access (${status}).`, status);
    }
    return failure("httpError", `The target answered ${status}.`, status);
  }
  if (message.startsWith(CONTENT_VETO)) {
    return failure("httpError", "The page produced no readable content.", status);
  }
  if (message.startsWith(ANTIBOT_PREFIX)) {
    const reason = message.slice(ANTIBOT_PREFIX.length).trim();
    return failure("blocked", `The target served an anti-bot page (${reason}).`, status);
  }
  if (/timeout|timed out/i.test(message)) {
    return failure("timeout", message, status);
  }
  if (/dns|resolve|connect/i.test(message)) {
    return failure("unreachable", message, status);
  }
  return failure("httpError", message, status);
}

export function toDocument(
  raw: RawCrawlResult,
  requested: string,
  prefer: MarkdownPreference = "raw",
): FetchedDocument {
  const markdown = markdownOf(raw.markdown, prefer);
  const metadata = (raw.metadata ?? {}) as { title?: unknown };
  const status = statusOf(raw);

  const vetoOverruled =
    raw.success !== true &&
    status !== null &&
    status >= 200 &&
    status < 300 &&
    str(raw.error_message).startsWith(CONTENT_VETO) &&
    hasContent(markdown);

  if ((raw.success !== true && !vetoOverruled) || markdown === null) {
    return {
      url: str(raw.url, requested),
      finalUrl: str(raw.redirected_url) || null,
      status: "failed",
      markdown: null,
      title: null,
      links: null,
      failure: resultFailure(raw),
    };
  }

  return {
    url: str(raw.url, requested),
    finalUrl: str(raw.redirected_url) || null,
    status: "ok",
    markdown,
    title: str(metadata.title) || null,
    links: linksOf(raw.links),
    failure: null,
  };
}

/**
 * One document per requested URL, in the order asked, from the stream's lines.
 *
 * The stream emits results as pages finish, so order is restored by URL. A
 * result reported under a different spelling of its URL is paired with the
 * remaining unmatched request instead, and a URL the server said nothing about
 * becomes an explicit failure instead of silently vanishing from the results.
 */
export function documentsFor(
  urls: readonly string[],
  lines: readonly unknown[],
  prefer: MarkdownPreference,
): FetchedDocument[] {
  const results: RawCrawlResult[] = lines.flatMap((line) => {
    if (!line || typeof line !== "object") return [];
    const entry = line as RawCrawlResult & { error?: unknown };
    if (typeof entry.url !== "string") return [];
    // A result the server could not serialise arrives as `{error, url}`.
    if (entry.success === undefined && entry.error !== undefined) {
      return [{ url: entry.url, success: false, error_message: str(entry.error) }];
    }
    return [entry];
  });

  const unclaimed = new Set(results);
  const byUrl = new Map<string, RawCrawlResult>();
  for (const r of results) {
    const key = str(r.url);
    if (!byUrl.has(key)) byUrl.set(key, r);
  }

  const matched = urls.map((requested) => {
    const raw = byUrl.get(requested);
    if (raw !== undefined && unclaimed.has(raw)) {
      unclaimed.delete(raw);
      return raw;
    }
    return undefined;
  });
  const leftovers = [...unclaimed];

  return urls.map((requested, index) => {
    const raw = matched[index] ?? leftovers.shift();
    if (raw === undefined) {
      return {
        url: requested,
        finalUrl: null,
        status: "failed" as const,
        markdown: null,
        title: null,
        links: null,
        failure: failure(
          "upstreamUnavailable",
          "The scraping backend returned no result for this URL.",
        ),
      };
    }
    return toDocument(raw, requested, prefer);
  });
}

/** Fetch one or more URLs in a single call. */
export async function crawl(
  urls: readonly string[],
  options: CrawlOptions = {},
): Promise<FetchedDocument[]> {
  if (urls.length === 0) return [];
  const readable = options.readable === true;

  const { body } = await request<unknown[]>(base("/crawl/stream"), {
    method: "POST",
    token: token(),
    body: { urls: [...urls], crawler_config: readable ? READABLE_CONFIG : STREAM_CONFIG },
    responseFormat: "ndjson",
    // A POST that creates nothing: the server fetches the pages and answers
    // with what it read, keeping no record of having been asked. Sending it
    // again after a transient failure costs another fetch and nothing else.
    idempotent: true,
    upstream: "crawl4ai",
    operation: options.operation ?? "crawl",
  });

  return documentsFor(urls, body, readable ? "fit" : "raw");
}

/** Fetch a single URL as readable markdown. */
export async function getMarkdown(url: string): Promise<FetchedDocument> {
  const [doc] = await crawl([url], { readable: true, operation: "markdown" });
  // A single-page read has never returned links; keep its output that size.
  return { ...doc!, links: null };
}

/** Submit an asynchronous crawl. Answers 202 with a task id. */
export async function submitCrawlJob(urls: readonly string[]): Promise<string> {
  const { body } = await request<RawJobSubmit>(base("/crawl/job"), {
    method: "POST",
    token: token(),
    body: { urls: [...urls] },
    expect: [202],
    // No `idempotent` here, and that is the point. This is the one call that
    // creates something: a retry after a failure that the server had in fact
    // accepted would leave a second job running, and the caller would only ever
    // learn the id of one of them - the other would crawl on unowned. A
    // transient failure surfacing to the caller is the cheaper outcome.
    upstream: "crawl4ai",
    operation: "submit_job",
  });

  const id = str(body.task_id);
  if (!id) {
    throw new UpstreamError(
      failure("upstreamUnavailable", "The scraping backend accepted the job but returned no task id."),
    );
  }
  return id;
}

/**
 * Map the upstream's TaskStatus (processing | completed | failed) onto ours.
 *
 * Unknown values are treated as still running rather than as a failure: a new
 * intermediate state added upstream should make the caller poll again, not
 * make it report a crawl that is still working as broken.
 */
function jobState(status: string): JobState {
  const s = status.toLowerCase();
  if (s === "completed" || s === "success") return "completed";
  if (s === "failed" || s === "error") return "failed";
  return "running";
}

/**
 * Poll a job.
 *
 * The status body carries a `_links` object, which is deliberately ignored: it
 * was observed pointing at `.../\/llm/<crawl id>` - a doubled slash and the
 * wrong route - so the polling URL is built here instead.
 */
export async function getJobStatus(jobId: string): Promise<CrawlJob> {
  const { body } = await request<RawJobStatus>(
    base(`/crawl/job/${encodeURIComponent(jobId)}`),
    { method: "GET", token: token(), upstream: "crawl4ai", operation: "job_status" },
  ).catch((error: unknown) => {
    // An unknown id is a caller mistake, not an upstream fault. Reporting it
    // as an HTTP error would send the agent looking for an outage.
    if (error instanceof UpstreamError && error.failure.upstreamStatus === 404) {
      throw new UpstreamError(
        failure("invalidInput", `No crawl job with id "${jobId}". It may have expired.`, 404),
      );
    }
    throw error;
  });

  const state = jobState(str(body.status, "running"));

  if (state === "failed") {
    return {
      jobId,
      state,
      documents: null,
      failure: failure("httpError", str(body.error, "The crawl failed upstream.")),
    };
  }

  if (state === "running") {
    return { jobId, state, documents: null, failure: null };
  }

  const result = (body.result ?? {}) as RawCrawlResponse;
  const rawResults = Array.isArray(result.results)
    ? (result.results as RawCrawlResult[])
    : [];

  return {
    jobId,
    state,
    documents: rawResults.map((r) => toDocument(r, str(r.url))),
    failure: null,
  };
}

/**
 * Structured extraction.
 *
 * The documented `POST /llm/{path}` does not exist in 0.9.2; the real route is
 * `GET /llm/{url}?q=...`. With no model credentials configured the endpoint is
 * unavailable, which callers turn into a degraded response rather than an
 * error.
 */
export async function extract(url: string, instruction: string): Promise<unknown> {
  const target = base(`/llm/${encodeURIComponent(url)}`);
  const withQuery = new URL(target);
  withQuery.searchParams.set("q", instruction);

  const { body } = await request<unknown>(withQuery.toString(), {
    method: "GET",
    token: token(),
    timeoutMs: 180_000,
    upstream: "crawl4ai",
    operation: "extract",
  });
  return body;
}

export async function health(): Promise<boolean> {
  try {
    await request<unknown>(base("/health"), { method: "GET", timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}
