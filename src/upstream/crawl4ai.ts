import { request } from "./http.js";
import { env } from "../utils/env.js";
import { failure, UpstreamError, type ToolFailure } from "../utils/errors.js";
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
 */

interface RawMarkdown {
  readonly raw_markdown?: unknown;
  readonly fit_markdown?: unknown;
}

interface RawLink {
  readonly href?: unknown;
  readonly text?: unknown;
}

interface RawCrawlResult {
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

function token(): string {
  return env().CRAWL4AI_API_TOKEN;
}

function base(path: string): string {
  return new URL(path, env().CRAWL4AI_URL).toString();
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * `markdown` is an object, not a string.
 *
 * `fit_markdown` is the filtered variant and comes back empty on plenty of
 * ordinary pages, so `raw_markdown` is the one to trust; fit is only a
 * fallback for the rare case where raw is the empty one.
 */
function markdownOf(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  if (value && typeof value === "object") {
    const m = value as RawMarkdown;
    const raw = str(m.raw_markdown);
    if (raw) return raw;
    const fit = str(m.fit_markdown);
    if (fit) return fit;
  }
  return null;
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
  const status = typeof raw.status_code === "number" ? raw.status_code : null;
  const message = str(raw.error_message, "The page could not be fetched.");

  if (status !== null && status >= 400) {
    if (status === 403 || status === 429) {
      return failure("blocked", `The target refused automated access (${status}).`, status);
    }
    return failure("httpError", `The target answered ${status}.`, status);
  }
  if (/timeout|timed out/i.test(message)) {
    return failure("timeout", message, status);
  }
  if (/dns|resolve|connect/i.test(message)) {
    return failure("unreachable", message, status);
  }
  return failure("httpError", message, status);
}

function toDocument(raw: RawCrawlResult, requested: string): FetchedDocument {
  const ok = raw.success === true;
  const markdown = markdownOf(raw.markdown);
  const metadata = (raw.metadata ?? {}) as { title?: unknown };

  if (!ok || markdown === null) {
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
 * Fetch one or more URLs in a single call.
 *
 * Order is preserved by matching on the requested URL rather than trusting the
 * response order, and a URL the server said nothing about becomes an explicit
 * failure instead of silently vanishing from the results.
 */
export async function crawl(urls: readonly string[]): Promise<FetchedDocument[]> {
  if (urls.length === 0) return [];

  const { body } = await request<RawCrawlResponse>(base("/crawl"), {
    method: "POST",
    token: token(),
    body: { urls: [...urls] },
    upstream: "crawl4ai",
    operation: "crawl",
  });

  const rawResults = Array.isArray(body.results)
    ? (body.results as RawCrawlResult[])
    : [];

  const byUrl = new Map<string, RawCrawlResult>();
  for (const r of rawResults) {
    const key = str(r.url);
    if (key && !byUrl.has(key)) byUrl.set(key, r);
  }

  return urls.map((requested, index) => {
    const raw = byUrl.get(requested) ?? rawResults[index];
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
    return toDocument(raw, requested);
  });
}

/** Fetch a single URL as markdown via the dedicated endpoint. */
export async function getMarkdown(url: string): Promise<FetchedDocument> {
  const { body } = await request<{ markdown?: unknown; success?: unknown }>(
    base("/md"),
    { method: "POST", token: token(), body: { url }, upstream: "crawl4ai", operation: "markdown" },
  );

  const markdown = markdownOf(body.markdown);
  if (body.success === false || markdown === null) {
    return {
      url,
      finalUrl: null,
      status: "failed",
      markdown: null,
      title: null,
      links: null,
      failure: failure("httpError", "The page produced no readable content."),
    };
  }

  return {
    url,
    finalUrl: null,
    status: "ok",
    markdown,
    title: null,
    links: null,
    failure: null,
  };
}

/** Submit an asynchronous crawl. Answers 202 with a task id. */
export async function submitCrawlJob(urls: readonly string[]): Promise<string> {
  const { body } = await request<RawJobSubmit>(base("/crawl/job"), {
    method: "POST",
    token: token(),
    body: { urls: [...urls] },
    expect: [202],
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
