import { request } from "./http.js";
import { env } from "../utils/env.js";
import { failure, UpstreamError } from "../utils/errors.js";
import type { EngineFailure, SearchHit, SearchResult } from "./types.js";

/**
 * SearXNG's JSON search API.
 *
 * `/search?format=json` always answers with the same seven keys. Only five are
 * read here; `corrections` and `infoboxes` are ignored on purpose, so upstream
 * can change them without touching this server.
 */

interface RawSearxngResult {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly content?: unknown;
  readonly engines?: unknown;
  readonly engine?: unknown;
  readonly score?: unknown;
}

interface RawSearxngResponse {
  readonly query?: unknown;
  readonly results?: unknown;
  readonly answers?: unknown;
  readonly suggestions?: unknown;
  readonly unresponsive_engines?: unknown;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    if (typeof v === "string") return [v];
    // `answers` has carried objects in some versions; take the obvious field.
    if (v && typeof v === "object" && "answer" in v) {
      const a = (v as { answer?: unknown }).answer;
      return typeof a === "string" ? [a] : [];
    }
    return [];
  });
}

/**
 * `unresponsive_engines` arrives as an array of arrays: [engine, reason],
 * e.g. [["duckduckgo","CAPTCHA"],["startpage","CAPTCHA"]] - not as objects.
 * Verified against a running instance, 2026-08-31.
 */
function engineFailures(value: unknown): EngineFailure[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (Array.isArray(entry)) {
      const engine = str(entry[0]);
      if (!engine) return [];
      return [{ engine, reason: str(entry[1], "unspecified") }];
    }
    if (entry && typeof entry === "object") {
      const e = entry as { engine?: unknown; reason?: unknown };
      const engine = str(e.engine);
      if (!engine) return [];
      return [{ engine, reason: str(e.reason, "unspecified") }];
    }
    return [];
  });
}

function toHit(raw: RawSearxngResult): SearchHit | null {
  const url = str(raw.url);
  if (!url) return null;
  const engines = Array.isArray(raw.engines)
    ? raw.engines.filter((e): e is string => typeof e === "string")
    : typeof raw.engine === "string"
      ? [raw.engine]
      : [];
  return {
    title: str(raw.title, url),
    url,
    snippet: str(raw.content),
    engines,
    score: typeof raw.score === "number" ? raw.score : null,
  };
}

export interface SearchOptions {
  readonly query: string;
  readonly limit: number;
  readonly language?: string | undefined;
  readonly categories?: readonly string[] | undefined;
}

export async function search(options: SearchOptions): Promise<SearchResult> {
  const url = new URL("/search", env().SEARXNG_URL);
  url.searchParams.set("q", options.query);
  url.searchParams.set("format", "json");
  if (options.language && options.language !== "auto") {
    url.searchParams.set("language", options.language);
  }
  if (options.categories?.length) {
    url.searchParams.set("categories", options.categories.join(","));
  }

  const { body, status } = await request<RawSearxngResponse>(url.toString(), {
    method: "GET",
    timeoutMs: 30_000,
    upstream: "searxng",
    operation: "search",
  }).catch((error: unknown) => {
    // A 403 here almost always means one thing, and saying so saves an
    // operator a long detour: `search.formats` has no environment-variable
    // override, so json must be enabled in settings.yml.
    if (error instanceof UpstreamError && error.failure.upstreamStatus === 403) {
      throw new UpstreamError(
        failure(
          "upstreamUnavailable",
          "SearXNG refused a JSON search with 403. Its settings.yml must list `json` under `search.formats`; there is no environment variable for this.",
          403,
        ),
      );
    }
    throw error;
  });

  if (status !== 200) {
    throw new UpstreamError(
      failure("upstreamUnavailable", `SearXNG answered ${status}.`, status),
    );
  }

  const rawResults = Array.isArray(body.results) ? body.results : [];
  const hits = rawResults
    .map((r) => toHit(r as RawSearxngResult))
    .filter((h): h is SearchHit => h !== null)
    .slice(0, options.limit);

  return {
    query: str(body.query, options.query),
    results: hits,
    answers: strList(body.answers),
    suggestions: strList(body.suggestions),
    unresponsiveEngines: engineFailures(body.unresponsive_engines),
  };
}
