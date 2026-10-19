import type { McpServer } from "@modelcontextprotocol/server";
import { MapInput } from "../schemas/tools.js";
import { crawl } from "../upstream/crawl4ai.js";
import type { TrimStep } from "../utils/fit.js";
import {
  ANNOTATIONS,
  egressGuard,
  fetchSlots,
  guarded,
  reply,
  replyFailure,
} from "./shared.js";

/**
 * How an over-long link listing is cut down, in order. External links go first
 * because the main use of this tool is to see the structure of the site itself,
 * which the internal links carry.
 */
export const MAP_STEPS: readonly TrimStep[] = [
  { kind: "items", path: "/external" },
  { kind: "items", path: "/internal" },
];

export function registerMapTool(server: McpServer): void {
  server.registerTool(
    "web_map",
    {
      title: "List the links on a page",
      description:
        "Fetch a page and list the URLs it links to, without returning the page body. Useful for " +
        "finding the shape of a site before deciding what to read. Internal links are returned by " +
        "default; external ones are opt-in.",
      inputSchema: MapInput,
      annotations: ANNOTATIONS,
    },
    async (params) =>
      guarded("web_map", async () => {
        const denied = await egressGuard(params.url);
        if (denied) return replyFailure(denied);

        const [doc] = await fetchSlots().run(() => crawl([params.url]));
        if (doc === undefined || doc.status === "failed") {
          return replyFailure(
            doc?.failure ?? {
              kind: "upstreamUnavailable",
              message: "The page could not be fetched.",
              upstreamStatus: null,
            },
          );
        }

        const internal = (doc.links?.internal ?? []).map((l) => l.href);
        const external = params.includeExternal
          ? (doc.links?.external ?? []).map((l) => l.href)
          : [];

        // Deduplicate while preserving order; a page routinely links the same
        // target from a nav bar and again from the body.
        const uniq = (list: string[]): string[] => [...new Set(list)];
        const internalUnique = uniq(internal).slice(0, params.limit);
        const externalUnique = uniq(external).slice(
          0,
          Math.max(0, params.limit - internalUnique.length),
        );

        const limitReached =
          uniq(internal).length > internalUnique.length ||
          uniq(external).length > externalUnique.length;

        return reply(
          { url: doc.url, internal: internalUnique, external: externalUnique, limitReached },
          MAP_STEPS,
          params.maxChars,
        );
      }),
  );
}
