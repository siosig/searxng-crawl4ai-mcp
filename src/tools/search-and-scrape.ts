import type { McpServer } from "@modelcontextprotocol/server";
import { SearchAndScrapeInput } from "../schemas/tools.js";
import { search } from "../upstream/searxng.js";
import { crawl } from "../upstream/crawl4ai.js";
import {
  ANNOTATIONS,
  countDocuments,
  documentsMarkdown,
  fetchSlots,
  guarded,
  partitionByEgress,
  reply,
} from "./shared.js";
import { recordSearch } from "../metrics/record.js";
import type { FetchedDocument } from "../upstream/types.js";

/**
 * Search and then read the top hits.
 *
 * This is the composition that justifies putting a server in front of the two
 * backends at all: neither of them can do it alone, and doing it client-side
 * costs an extra round trip plus the model's attention on plumbing.
 */
export function registerSearchAndScrapeTool(server: McpServer): void {
  server.registerTool(
    "web_search_and_scrape",
    {
      title: "Search, then read the best results",
      description:
        "Search the web and fetch the full content of the top hits in one call, so the answer arrives " +
        "with the sources already read. Prefer this over calling web_search and web_scrape separately " +
        "when the goal is to answer a question rather than to browse. A hit that cannot be fetched is " +
        "reported and the rest still come back.",
      inputSchema: SearchAndScrapeInput,
      annotations: ANNOTATIONS,
    },
    async (params) =>
      guarded("web_search_and_scrape", params.format, async () => {
        const result = await search({
          query: params.query,
          limit: params.topN,
          language: params.language,
          // Same three as web_search, forwarded the same way. Narrowing the
          // search is what decides which pages get read here, so it matters
          // more in this tool than in the one that only lists hits.
          engines: params.engines,
          timeRange: params.timeRange,
          safesearch: params.safesearch,
        });

        const urls = result.results.slice(0, params.topN).map((h) => h.url);
        const { allowed, refused } = await partitionByEgress(urls);

        const fetched =
          allowed.length > 0 ? await fetchSlots().run(() => crawl(allowed)) : [];
        const byUrl = new Map(fetched.map((d) => [d.url, d]));

        const documents: FetchedDocument[] = urls.map((url) => {
          const denial = refused.get(url);
          if (denial) {
            return { url, finalUrl: null, status: "failed", markdown: null, title: null, links: null, failure: denial };
          }
          return (
            byUrl.get(url) ?? {
              url,
              finalUrl: null,
              status: "failed",
              markdown: null,
              title: null,
              links: null,
              failure: { kind: "upstreamUnavailable", message: "No result for this URL.", upstreamStatus: null },
            }
          );
        });

        recordSearch(result.results.length, result.unresponsiveEngines);
        countDocuments(documents);

        const engineNote = result.unresponsiveEngines.length
          ? `\n\n_Engines that did not answer: ${result.unresponsiveEngines
              .map((e) => `${e.engine} (${e.reason})`)
              .join(", ")}._`
          : "";

        const headline =
          documents.length === 0
            ? `No results for "${params.query}", so nothing was fetched.`
            : `Read ${documents.filter((d) => d.status === "ok").length} of ${documents.length} top results for "${params.query}".`;

        return reply(
          `${headline}${engineNote}\n\n${documentsMarkdown(documents)}`,
          { search: result, documents },
          params.format,
        );
      }),
  );
}
