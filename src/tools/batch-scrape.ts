import type { McpServer } from "@modelcontextprotocol/server";
import { BatchScrapeInput } from "../schemas/tools.js";
import { crawl } from "../upstream/crawl4ai.js";
import type { TrimStep } from "../utils/fit.js";
import {
  ANNOTATIONS,
  countDocuments,
  fetchSlots,
  guarded,
  partitionByEgress,
  reply,
} from "./shared.js";
import type { FetchedDocument } from "../upstream/types.js";

/**
 * Documents are shortened together, so one large page cannot crowd out the
 * rest of the batch; the per-URL entries stay in the caller's order.
 */
export const BATCH_SCRAPE_STEPS: readonly TrimStep[] = [{ kind: "documents", path: "/documents" }];

export function registerBatchScrapeTool(server: McpServer): void {
  server.registerTool(
    "web_batch_scrape",
    {
      title: "Fetch several pages",
      description:
        "Fetch a list of pages in one call. Each URL succeeds or fails on its own: a page that is " +
        "unreachable, blocked or refused by outbound policy does not stop the others, and the reason " +
        "is reported per URL. Results come back in the order the URLs were given.",
      inputSchema: BatchScrapeInput,
      annotations: ANNOTATIONS,
    },
    async (params) =>
      guarded("web_batch_scrape", async () => {
        const { allowed, refused } = await partitionByEgress(params.urls);

        const fetched =
          allowed.length > 0
            ? await fetchSlots().run(() => crawl(allowed))
            : [];
        const byUrl = new Map(fetched.map((d) => [d.url, d]));

        // Rebuild in the caller's order, so position still identifies the URL.
        const documents: FetchedDocument[] = params.urls.map((url) => {
          const denial = refused.get(url);
          if (denial) {
            return {
              url,
              finalUrl: null,
              status: "failed" as const,
              markdown: null,
              title: null,
              links: null,
              failure: denial,
            };
          }
          return (
            byUrl.get(url) ?? {
              url,
              finalUrl: null,
              status: "failed" as const,
              markdown: null,
              title: null,
              links: null,
              failure: {
                kind: "upstreamUnavailable" as const,
                message: "No result was returned for this URL.",
                upstreamStatus: null,
              },
            }
          );
        });

        countDocuments(documents);

        const okCount = documents.filter((d) => d.status === "ok").length;
        return reply({ documents, okCount, failedCount: documents.length - okCount }, BATCH_SCRAPE_STEPS);
      }),
  );
}
