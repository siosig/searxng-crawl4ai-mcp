import type { McpServer } from "@modelcontextprotocol/server";
import { SearchInput } from "../schemas/tools.js";
import { search } from "../upstream/searxng.js";
import { ANNOTATIONS, guarded, reply, cell } from "./shared.js";
import { recordSearch } from "../metrics/record.js";
import type { SearchCoverage, SearchResult, ShortfallReason } from "../upstream/types.js";

/**
 * What to say when the requested count was not met.
 *
 * One sentence per reason, because the reasons imply different next moves: a
 * caller told the engines ran dry should change the query, one told a limit was
 * hit should narrow it, and one told the upstream failed should simply ask
 * again. A single "fewer results than requested" would leave all three to be
 * guessed at, which is the silence this feature exists to break.
 */
/**
 * Why a search came up short, phrased so the next move is obvious.
 *
 * An agent that is handed fewer results than it asked for has two very
 * different situations to tell apart, and only one of them is worth another
 * query: `exhausted` means rephrasing is the only thing left to try, while the
 * other three mean this server stopped early and the same search would find
 * more. Saying merely "34 results" collapses that distinction.
 */
const SHORTFALL_NOTE: Record<ShortfallReason, (c: SearchCoverage) => string> = {
  exhausted: (c) => `${c.requested} were requested, but the engines have no more to give.`,
  page_limit: () =>
    "the page limit was reached. A narrower query would concentrate what you want near the top.",
  time_budget: () => "the time budget for one search was spent.",
  upstream_failed: () =>
    "an upstream failed while fetching further pages. What had been gathered is returned.",
};

function toMarkdown(r: SearchResult): string {
  const lines: string[] = [];

  if (r.results.length === 0) {
    // Saying *why* there is nothing matters more than the empty list. An agent
    // that cannot tell "no such thing on the web" from "every engine refused
    // us" will rephrase a perfectly good query forever.
    lines.push(
      r.unresponsiveEngines.length > 0
        ? "No results, and some engines did not answer - see below. This may be a blocking problem rather than an empty web."
        : "No results. Every engine answered; the web has nothing for this query.",
    );
  } else {
    lines.push(`${r.results.length} results for "${r.query}".`, "");
    for (const [i, hit] of r.results.entries()) {
      lines.push(`${i + 1}. **${cell(hit.title)}**`);
      lines.push(`   ${hit.url}`);
      if (hit.snippet) lines.push(`   ${cell(hit.snippet)}`);
      if (hit.engines.length) lines.push(`   _via ${hit.engines.join(", ")}_`);
      lines.push("");
    }
  }

  // Directly under the results, where a reader who has just counted them is
  // asking the question this answers. A satisfied search says nothing here at
  // all: the ordinary case must read exactly as it did before paging existed.
  if (r.coverage.shortfall !== null) {
    lines.push(
      `_Stopped at ${r.coverage.returned}: ${SHORTFALL_NOTE[r.coverage.shortfall](r.coverage)}_`,
      "",
    );
  }

  if (r.answers.length) lines.push("**Direct answers**", ...r.answers.map((a) => `- ${a}`), "");
  if (r.suggestions.length) lines.push(`**Related**: ${r.suggestions.join(", ")}`, "");

  if (r.unresponsiveEngines.length) {
    lines.push("**Engines that did not answer**");
    for (const e of r.unresponsiveEngines) lines.push(`- ${e.engine}: ${e.reason}`);
  }

  return lines.join("\n");
}

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
        "listed separately so a blocked search can be told apart from a genuinely empty one.",
      inputSchema: SearchInput,
      annotations: ANNOTATIONS,
    },
    async (params) =>
      guarded("web_search", params.format, async () => {
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
        // `coverage` reaches the structured output through this spread rather
        // than being assembled here: it is part of the result, so the machine
        // readable form and the prose above cannot come to disagree.
        // The gathered count matters only when the text had to be cut: it turns
        // "this was too long" into "50 were found and the text stops part way
        // through them", which points at format: "json" as the way to see all
        // of them rather than at rewriting the query.
        return reply(toMarkdown(result), { ...result }, params.format, result.coverage.returned);
      }),
  );
}
