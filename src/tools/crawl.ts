import type { McpServer } from "@modelcontextprotocol/server";
import { CrawlInput } from "../schemas/tools.js";
import { crawl } from "../upstream/crawl4ai.js";
import {
  ANNOTATIONS,
  countDocuments,
  documentsMarkdown,
  egressGuard,
  fetchSlots,
  guarded,
  reply,
  replyFailure,
} from "./shared.js";
import type { FetchedDocument } from "../upstream/types.js";
import { logger } from "../utils/logger.js";

/**
 * Crawl a site a level at a time.
 *
 * The scraping backend refuses `deep_crawl_strategy` from any HTTP caller -
 * it treats every API request as untrusted and the field is on its forbidden
 * list - so multi-level crawling cannot be delegated to it. What is delegated
 * is all the hard part: fetching, rendering and link extraction. What happens
 * here is only the ordering: fetch a level, collect the links, fetch the next.
 *
 * If a future release allows depth to be requested directly, this loop is the
 * thing to delete.
 */

const BATCH = 5;

function sameHost(candidate: string, origin: URL): boolean {
  try {
    return new URL(candidate).host === origin.host;
  } catch {
    return false;
  }
}

/** Drop the fragment so `/page` and `/page#section` are not fetched twice. */
function canonical(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export function registerCrawlTool(server: McpServer): void {
  server.registerTool(
    "web_crawl",
    {
      title: "Crawl a site",
      description:
        "Start at a URL and follow its links, returning the pages found as markdown. Both the number " +
        "of link hops (maxDepth) and the total number of pages (maxPages) are capped, and reaching a " +
        "cap ends the crawl normally rather than as a failure. Stays on the starting host unless told " +
        "otherwise. Use web_scrape for a single page and web_map to see a site's shape first.",
      inputSchema: CrawlInput,
      annotations: ANNOTATIONS,
    },
    async (params) =>
      guarded("web_crawl", params.format, async () => {
        const denied = await egressGuard(params.url);
        if (denied) return replyFailure(denied, params.format);

        const start = canonical(params.url);
        if (start === null) {
          return replyFailure(
            { kind: "invalidInput", message: `Not a crawlable URL: ${params.url}`, upstreamStatus: null },
            params.format,
          );
        }
        const origin = new URL(start);

        const seen = new Set<string>([start]);
        const documents: FetchedDocument[] = [];
        let frontier: string[] = [start];
        let depth = 0;
        let stoppedAt: "depth" | "pages" | "exhausted" = "exhausted";

        while (frontier.length > 0 && depth <= params.maxDepth) {
          if (documents.length >= params.maxPages) {
            stoppedAt = "pages";
            break;
          }

          const room = params.maxPages - documents.length;
          const level = frontier.slice(0, room);
          // Dropping part of a level *is* hitting the page cap, even though the
          // loop has not exited yet. Without this the crawl would report
          // "exhausted" while silently leaving pages unvisited.
          if (level.length < frontier.length) stoppedAt = "pages";
          frontier = [];

          for (let i = 0; i < level.length; i += BATCH) {
            const batch = level.slice(i, i + BATCH);
            const fetched = await fetchSlots().run(() => crawl(batch));
            countDocuments(fetched);
            documents.push(...fetched);

            if (depth < params.maxDepth) {
              for (const doc of fetched) {
                for (const link of doc.links?.internal ?? []) {
                  const next = canonical(link.href);
                  if (next === null || seen.has(next)) continue;
                  if (params.sameHostOnly && !sameHost(next, origin)) continue;
                  seen.add(next);
                  frontier.push(next);
                }
              }
            }
          }

          depth += 1;
          if (depth > params.maxDepth && frontier.length > 0) stoppedAt = "depth";
        }

        if (frontier.length > 0 && documents.length >= params.maxPages) {
          stoppedAt = "pages";
        }

        logger.info(
          { tool: "web_crawl", pages: documents.length, depth, stoppedAt },
          "crawl finished",
        );

        const note =
          stoppedAt === "pages"
            ? `Stopped at the ${params.maxPages}-page limit; more pages remain.`
            : stoppedAt === "depth"
              ? `Stopped at depth ${params.maxDepth}; deeper pages were not followed.`
              : "Followed every reachable link within the limits.";

        return reply(
          `Crawled ${documents.length} pages from ${start}. ${note}\n\n${documentsMarkdown(documents)}`,
          {
            start,
            state: "completed",
            pagesFetched: documents.length,
            depthReached: Math.min(depth, params.maxDepth),
            stoppedAt,
            documents,
          },
          params.format,
        );
      }),
  );
}
