import type { McpServer } from "@modelcontextprotocol/server";
import { ExtractInput } from "../schemas/tools.js";
import { extract, getMarkdown } from "../upstream/crawl4ai.js";
import { env } from "../utils/env.js";
import type { TrimStep } from "../utils/fit.js";
import {
  ANNOTATIONS,
  egressGuard,
  fetchSlots,
  guarded,
  reply,
  replyFailure,
} from "./shared.js";
import { logger } from "../utils/logger.js";

/**
 * Trim order for an extraction result: shorten the extracted data item by item,
 * and drop it outright only if even that does not fit. The data is the whole
 * point of the call, so it is the last thing to go.
 */
export const EXTRACT_STEPS: readonly TrimStep[] = [
  { kind: "items", path: "/data" },
  { kind: "drop", path: "/data" },
];

/**
 * Trim order for the degraded result, where the page markdown is the only
 * payload: cut it down rather than lose it.
 */
export const EXTRACT_DEGRADED_STEPS: readonly TrimStep[] = [{ kind: "text", path: "/markdown" }];

export function registerExtractTool(server: McpServer): void {
  server.registerTool(
    "web_extract",
    {
      title: "Extract structured data from a page",
      description:
        "Pull specific fields out of a page by describing them in plain language, for example " +
        '"the product name, price and availability". ' +
        "When no language-model credentials are configured this does not fail: it returns the page " +
        "content as markdown with degraded set to true, leaving the reading to the caller.",
      inputSchema: ExtractInput,
      annotations: ANNOTATIONS,
    },
    async (params) =>
      guarded("web_extract", async () => {
        const denied = await egressGuard(params.url);
        if (denied) return replyFailure(denied);

        // Degrade rather than fail. Extraction is the one capability that needs
        // an external credential, and the whole stack is meant to stand up
        // without one.
        if (env().GEMINI_API_KEY === undefined) {
          logger.info({ tool: "web_extract" }, "no model credentials; returning page content");
          const doc = await fetchSlots().run(() => getMarkdown(params.url, { keepLinks: params.keepLinks }));
          if (doc.status === "failed") return replyFailure(doc.failure!);

          return reply(
            { url: params.url, data: null, degraded: true, markdown: doc.markdown, failure: null },
            EXTRACT_DEGRADED_STEPS,
            params.maxChars,
          );
        }

        const data = await fetchSlots().run(() => extract(params.url, params.instruction));
        return reply(
          { url: params.url, data, degraded: false, markdown: null, failure: null },
          EXTRACT_STEPS,
          params.maxChars,
        );
      }),
  );
}
