import type { McpServer } from "@modelcontextprotocol/server";
import { SearchInput } from "../schemas/tools.js";
import { search } from "../upstream/searxng.js";
import { ANNOTATIONS, guarded, reply, cell } from "./shared.js";
import { recordSearch } from "../metrics/record.js";
import type { SearchResult } from "../upstream/types.js";

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
        });
        // Hit count and engine failures go in together: an empty result set
        // only means something alongside whether any engine refused to answer.
        recordSearch(result.results.length, result.unresponsiveEngines);
        return reply(toMarkdown(result), { ...result }, params.format);
      }),
  );
}
