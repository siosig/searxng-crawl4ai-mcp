/**
 * Values that several modules share and that reviewers are likely to look for
 * in one place. Anything environment-specific belongs in the environment
 * instead - see src/utils/env.ts.
 */

/**
 * Upper bound on the size of a single tool response, in characters.
 *
 * Tool output is fed straight into a model context, so an unbounded page dump
 * can crowd out everything else the agent was holding. Responses longer than
 * this are truncated and flagged, rather than silently trimmed.
 */
export const CHARACTER_LIMIT = 25_000;

/**
 * Default number of page fetches allowed to run at the same time.
 *
 * Each fetch occupies a browser in the Crawl4AI container, so this is really a
 * memory and CPU budget. The default suits a developer machine; low-power
 * hosts should lower it through MAX_CONCURRENT_FETCHES rather than editing
 * this constant.
 */
export const DEFAULT_MAX_CONCURRENT_FETCHES = 4;

/** Port the MCP server listens on when PORT is not set. */
export const DEFAULT_PORT = 3000;

/**
 * How many result pages a single search may fetch from SearXNG.
 *
 * A page is one round trip that fans out to every configured engine, so this is
 * a latency budget as much as a politeness one. The default `limit` of 10 is
 * satisfied by the first page, which means an ordinary search never pays for a
 * second one; only a caller that explicitly asks for many results does.
 *
 * Not configurable on purpose. Raising it does not get more results - a search
 * that has not been satisfied in five pages runs into the time budget below
 * instead - and lowering it only makes the shortfall reason less informative.
 */
export const SEARCH_MAX_PAGES = 5;

/**
 * Wall-clock budget for one search, across all of its pages.
 *
 * Page count alone is not enough of a guard: a slow engine configuration can
 * make five pages take minutes. Whichever limit is reached first stops the
 * search, and the caller is told which one it was.
 */
export const SEARCH_TIME_BUDGET_MS = 45_000;

/**
 * Backoff schedule for retrying an upstream request.
 *
 * The two waits are 250ms and 500ms before jitter, and jitter multiplies each
 * by 1-2, so the worst case total wait is 1.5s - inside RETRY_WAIT_BUDGET_MS
 * with room to spare.
 */
export const RETRY_MIN_WAIT_MS = 250;
export const RETRY_MAX_WAIT_MS = 1_000;

/**
 * The most time retrying may add to a single upstream request.
 *
 * This is the whole of the guarantee: a retry never makes a call take more than
 * this much longer than it would have without retries. It is also what decides,
 * without any special-casing, that a request which failed by exhausting its own
 * timeout is not retried - the elapsed time already leaves no room.
 *
 * Deliberately not configurable. Exposing it would let an operator widen the
 * budget until the inequality in specs/003/contracts/retry.md stops holding,
 * and the guarantee above would quietly stop being true.
 */
export const RETRY_WAIT_BUDGET_MS = 2_000;

/** Attempts, including the first. 1 disables retrying; RETRY_MAX_ATTEMPTS overrides. */
export const DEFAULT_RETRY_ATTEMPTS = 3;
