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
