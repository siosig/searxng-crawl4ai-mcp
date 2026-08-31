import { request } from "./http.js";
import { SEARCH_MAX_PAGES, SEARCH_TIME_BUDGET_MS } from "../constants.js";
import { recordSearchShortfall } from "../metrics/record.js";
import { env } from "../utils/env.js";
import { failure, UpstreamError } from "../utils/errors.js";
import type {
  EngineFailure,
  SearchHit,
  SearchResult,
  ShortfallReason,
} from "./types.js";

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

/** The periods SearXNG's `time_range` accepts. It has no others. */
export type TimeRange = "day" | "week" | "month" | "year";

export interface SearchOptions {
  readonly query: string;
  readonly limit: number;
  readonly language?: string | undefined;
  readonly categories?: readonly string[] | undefined;
  /**
   * Engine names as the instance knows them, not validated here.
   *
   * Which engines exist is settings.yml's business, and a copy of that list in
   * this repository would go stale the first time an operator edits theirs. An
   * unknown name is ignored upstream and shows up as a thin result set or in
   * `unresponsive_engines`, which is a better signal than a refusal we invented.
   */
  readonly engines?: readonly string[] | undefined;
  readonly timeRange?: TimeRange | undefined;
  readonly safesearch?: 0 | 1 | 2 | undefined;
}

/** One page of results, before anything is merged with its neighbours. */
interface SearchPage {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly answers: readonly string[];
  readonly suggestions: readonly string[];
  readonly unresponsiveEngines: readonly EngineFailure[];
}

/**
 * Ask the instance for one page. Throws exactly as it always has.
 *
 * Whether a thrown page is fatal or merely stops the search is the caller's
 * decision, not this function's - it depends on whether anything has been
 * gathered yet, which only the loop knows.
 */
async function fetchPage(options: SearchOptions, pageno: number): Promise<SearchPage> {
  const url = new URL("/search", env().SEARXNG_URL);
  url.searchParams.set("q", options.query);
  url.searchParams.set("format", "json");
  if (options.language && options.language !== "auto") {
    url.searchParams.set("language", options.language);
  }
  // The narrowing parameters are set only when they were asked for, so a call
  // that omits all three sends byte-for-byte the request this client sent
  // before they existed. Sending a default instead would make "no preference"
  // override whatever the instance was configured to do.
  if (options.engines?.length) {
    // One comma-joined value; SearXNG does not read repeated `engines` keys.
    url.searchParams.set("engines", options.engines.join(","));

    // `categories` is deliberately not sent alongside. SearXNG takes the union
    // of the two, so naming an engine while also naming a category widens the
    // selection back out instead of narrowing it - measured against a live
    // instance: `engines=duckduckgo&categories=general` came back entirely from
    // brave and google cse, while `engines=duckduckgo` alone restricted
    // correctly and reported duckduckgo as refused.
    //
    // Since `categories` carries a default of ["general"], every call was
    // sending it, and the engine list this tool advertises as a way to limit
    // the search never limited anything. Between honouring the description and
    // rewriting it, honouring it is the only option that leaves the tool
    // telling the truth.
  } else if (options.categories?.length) {
    url.searchParams.set("categories", options.categories.join(","));
  }
  if (options.timeRange !== undefined) {
    url.searchParams.set("time_range", options.timeRange);
  }
  // Compared against undefined rather than tested for truth: 0 is "off", a
  // level the caller can deliberately ask for, and a truthiness check would
  // drop it and leave the instance's own setting in force.
  if (options.safesearch !== undefined) {
    url.searchParams.set("safesearch", String(options.safesearch));
  }
  // From the second page onwards only. An absent `pageno` already means the
  // first page, so `pageno=1` would ask for exactly the same results while
  // changing the query string - and the promise that a search with no
  // narrowing arguments sends the request this client sent before paging
  // existed (SC-003) is a claim about the bytes, not about the meaning.
  if (pageno > 1) {
    url.searchParams.set("pageno", String(pageno));
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

  return {
    query: str(body.query, options.query),
    hits: rawResults
      .map((r) => toHit(r as RawSearxngResult))
      .filter((h): h is SearchHit => h !== null),
    answers: strList(body.answers),
    suggestions: strList(body.suggestions),
    unresponsiveEngines: engineFailures(body.unresponsive_engines),
  };
}

/**
 * Search, following pages until the requested count is met or something stops
 * us - and saying which it was.
 *
 * One page of SearXNG results is whatever the engines happened to agree on, so
 * asking for 30 and returning the 14 that fit on a page is a quiet lie: the
 * caller reads it as "the web has 14 of these". The five stopping conditions
 * are listed in specs/003-search-controls-retry-stdio/contracts/search-tools.md
 * and appear below in that order, which is also their precedence.
 */
export async function search(options: SearchOptions): Promise<SearchResult> {
  const startedAt = performance.now();

  const hits: SearchHit[] = [];
  // Duplicates are matched on the URL exactly as it arrived. Normalising first
  // - stripping a trailing slash, folding a query string - is a guess about
  // what a site considers the same page, and a wrong guess silently drops a
  // result the caller wanted rather than merely repeating one it did not.
  const seen = new Set<string>();
  const answers = new Set<string>();
  const suggestions = new Set<string>();
  const unresponsive = new Map<string, EngineFailure>();

  let query = options.query;
  let pagesFetched = 0;
  let shortfall: ShortfallReason | null = null;

  for (let pageno = 1; pageno <= SEARCH_MAX_PAGES; pageno++) {
    let page: SearchPage;
    try {
      page = await fetchPage(options, pageno);
    } catch (error) {
      // The asymmetry is the point. With nothing gathered there is no partial
      // answer to give, and dressing an outage up as a thin result set would
      // send an agent off rephrasing a query that was never asked. Once a page
      // has landed, the opposite holds: what we have is worth more than the
      // failure that stopped us getting more.
      if (pagesFetched === 0) throw error;
      shortfall = "upstream_failed";
      break;
    }

    pagesFetched++;
    // The instance echoes the query it actually ran, which can differ from what
    // was sent. The first page's answer is the one to keep; later pages repeat
    // it, and taking the last would let a paged search disagree with an
    // unpaged one for no reason.
    if (pagesFetched === 1) query = page.query;
    for (const answer of page.answers) answers.add(answer);
    for (const suggestion of page.suggestions) suggestions.add(suggestion);
    // Keyed by engine so a failure repeated on every page is reported once. An
    // engine that only broke on page three still gets reported: the caller is
    // being told which engines contributed to this result set, and that is a
    // question about the whole search, not about its first page.
    for (const failed of page.unresponsiveEngines) {
      if (!unresponsive.has(failed.engine)) unresponsive.set(failed.engine, failed);
    }

    let added = 0;
    for (const hit of page.hits) {
      if (hits.length >= options.limit) break;
      if (seen.has(hit.url)) continue;
      seen.add(hit.url);
      hits.push(hit);
      added++;
    }

    if (hits.length >= options.limit) break;

    // Nothing new on a whole page means the engines have run dry; asking for
    // page six of a query with three answers costs a fan-out to every engine
    // and returns the same three again (FR-031).
    if (added === 0) {
      shortfall = "exhausted";
      break;
    }

    if (pageno === SEARCH_MAX_PAGES) {
      shortfall = "page_limit";
      break;
    }

    // Checked between pages rather than raced against the request in flight: a
    // page already paid for should be kept, and cancelling mid-flight would
    // throw away results the upstream had already done the work to produce.
    if (performance.now() - startedAt > SEARCH_TIME_BUDGET_MS) {
      shortfall = "time_budget";
      break;
    }
  }

  // Every exit above either fills the request or names a reason, so these two
  // cannot disagree - which is the invariant the caller is promised.
  if (shortfall !== null) recordSearchShortfall(shortfall);

  return {
    query,
    results: hits,
    answers: [...answers],
    suggestions: [...suggestions],
    unresponsiveEngines: [...unresponsive.values()],
    coverage: {
      requested: options.limit,
      returned: hits.length,
      pagesFetched,
      satisfied: shortfall === null,
      shortfall,
    },
  };
}
