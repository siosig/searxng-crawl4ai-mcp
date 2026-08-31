/**
 * The normalised shapes the rest of the server sees.
 *
 * Nothing outside src/upstream/ knows what SearXNG or Crawl4AI actually
 * returned. When an upstream changes the shape of its response, the repair
 * happens in the mapping functions and these types stay put - which is the
 * whole point of having them.
 */

import type { ToolFailure } from "../utils/errors.js";

export interface EngineFailure {
  readonly engine: string;
  /** Reason as reported upstream, e.g. "CAPTCHA" or "timeout". */
  readonly reason: string;
}

export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly engines: readonly string[];
  readonly score: number | null;
}

export interface SearchResult {
  readonly query: string;
  readonly results: readonly SearchHit[];
  readonly answers: readonly string[];
  readonly suggestions: readonly string[];
  /**
   * Engines that did not answer, and why.
   *
   * This is what separates "the web has nothing for this query" from "every
   * engine refused us". Without it an agent cannot tell a genuine zero-result
   * search from a broken deployment.
   */
  readonly unresponsiveEngines: readonly EngineFailure[];
}

export interface PageLink {
  readonly href: string;
  readonly text: string;
}

export interface FetchedDocument {
  readonly url: string;
  readonly finalUrl: string | null;
  readonly status: "ok" | "failed";
  readonly markdown: string | null;
  readonly title: string | null;
  readonly links: { readonly internal: readonly PageLink[]; readonly external: readonly PageLink[] } | null;
  readonly failure: ToolFailure | null;
}

export type JobState = "running" | "completed" | "failed";

export interface CrawlJob {
  readonly jobId: string;
  readonly state: JobState;
  readonly documents: readonly FetchedDocument[] | null;
  readonly failure: ToolFailure | null;
}
