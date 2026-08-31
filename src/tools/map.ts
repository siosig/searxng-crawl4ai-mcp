import type { McpServer } from "@modelcontextprotocol/server";
import { MapInput } from "../schemas/tools.js";
import { crawl } from "../upstream/crawl4ai.js";
import {
  ANNOTATIONS,
  egressGuard,
  fetchSlots,
  guarded,
  reply,
  replyFailure,
} from "./shared.js";

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
      guarded("web_map", params.format, async () => {
        const denied = await egressGuard(params.url);
        if (denied) return replyFailure(denied, params.format);

        const [doc] = await fetchSlots().run(() => crawl([params.url]));
        if (doc === undefined || doc.status === "failed") {
          return replyFailure(
            doc?.failure ?? {
              kind: "upstreamUnavailable",
              message: "The page could not be fetched.",
              upstreamStatus: null,
            },
            params.format,
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

        const truncatedList =
          uniq(internal).length > internalUnique.length ||
          uniq(external).length > externalUnique.length;

        const lines = [
          `Links on ${doc.url}`,
          "",
          `**Internal (${internalUnique.length})**`,
          ...internalUnique.map((u) => `- ${u}`),
        ];
        if (params.includeExternal) {
          lines.push("", `**External (${externalUnique.length})**`, ...externalUnique.map((u) => `- ${u}`));
        }
        if (truncatedList) {
          lines.push("", `_More links exist; raise \`limit\` to see them._`);
        }

        return reply(
          lines.join("\n"),
          {
            url: doc.url,
            internal: internalUnique,
            external: externalUnique,
            truncated: truncatedList,
          },
          params.format,
        );
      }),
  );
}
