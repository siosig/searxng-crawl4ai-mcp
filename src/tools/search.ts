import type { McpServer } from "@modelcontextprotocol/server";
import { SearchInput } from "../schemas/tools.js";
import { search } from "../upstream/searxng.js";
import { ANNOTATIONS, guarded, reply } from "./shared.js";
import { recordSearch } from "../metrics/record.js";
import type { TrimStep } from "../utils/fit.js";

/**
 * What to drop, in order, when a search result outgrows the size limit.
 *
 * Results go first because they are the bulk of the output and are ranked, so
 * the tail is the least valuable part. Answers, suggestions and the list of
 * unresponsive engines follow, since each is small and loses meaning only once
 * the results are already gone.
 */
export const SEARCH_STEPS: readonly TrimStep[] = [
  { kind: "items", path: "/results" },
  { kind: "items", path: "/answers" },
  { kind: "items", path: "/suggestions" },
  { kind: "items", path: "/unresponsiveEngines" },
];

export function registerSearchTool(server: McpServer): void {
  server.registerTool(
    "web_search",
    {
      title: "Search the web",
      description:
        "Search the web across several engines at once, through a self-hosted metasearch instance. " +
        "Returns titles, URLs and snippets. " +
        "The search can be narrowed to a period (day, week, month, year) or to named engines, " +
        "which is the cheapest way to get recent results instead of whatever ranks highest. " +
        "An empty result list is a real answer, not an error; when engines fail to respond they are " +
        "listed separately so a blocked search can be told apart from a genuinely empty one. " +
        "When fewer results come back than were asked for, coverage.shortfall says why: " +
        "\"exhausted\" means the engines have nothing more and only a different query can help; " +
        "\"page_limit\", \"time_budget\" and \"upstream_failed\" mean this server stopped early " +
        "and the same search may find more.",
      inputSchema: SearchInput,
      annotations: ANNOTATIONS,
    },
    async (params) =>
      guarded("web_search", async () => {
        const result = await search({
          query: params.query,
          limit: params.limit,
          language: params.language,
          categories: params.categories,
          // Passed straight through, undefined included: the client is what
          // decides whether an argument reaches the upstream, so there is
          // nothing to decide here.
          engines: params.engines,
          timeRange: params.timeRange,
          safesearch: params.safesearch,
        });
        // Hit count and engine failures go in together: an empty result set
        // only means something alongside whether any engine refused to answer.
        recordSearch(result.results.length, result.unresponsiveEngines);
        // `coverage` reaches the structured output through this spread rather than
        // being assembled here: it is part of the result.
        return reply({ ...result }, SEARCH_STEPS);
      }),
  );
}
