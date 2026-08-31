import type { McpServer } from "@modelcontextprotocol/server";
import { ExtractInput } from "../schemas/tools.js";
import { extract, getMarkdown } from "../upstream/crawl4ai.js";
import { env } from "../utils/env.js";
import {
  ANNOTATIONS,
  egressGuard,
  fetchSlots,
  guarded,
  reply,
  replyFailure,
} from "./shared.js";
import { logger } from "../utils/logger.js";

export function registerExtractTool(server: McpServer): void {
  server.registerTool(
    "web_extract",
    {
      title: "Extract structured data from a page",
      description:
        "Pull specific fields out of a page by describing them in plain language, for example " +
        '"the product name, price and availability". ' +
        "When no language-model credentials are configured this does not fail: it returns the page " +
        "content as markdown and says it did so, leaving the reading to the caller.",
      inputSchema: ExtractInput,
      annotations: ANNOTATIONS,
    },
    async (params) =>
      guarded("web_extract", params.format, async () => {
        const denied = await egressGuard(params.url);
        if (denied) return replyFailure(denied, params.format);

        // Degrade rather than fail. Extraction is the one capability that needs
        // an external credential, and the whole stack is meant to stand up
        // without one.
        if (env().GEMINI_API_KEY === undefined) {
          logger.info({ tool: "web_extract" }, "no model credentials; returning page content");
          const doc = await fetchSlots().run(() => getMarkdown(params.url));
          if (doc.status === "failed") return replyFailure(doc.failure!, params.format);

          return reply(
            `_No language-model credentials are configured, so the page is returned as-is._\n\n` +
              `### ${params.url}\n\n${doc.markdown ?? ""}`,
            { url: params.url, data: null, degraded: true, markdown: doc.markdown, failure: null },
            params.format,
          );
        }

        const data = await fetchSlots().run(() => extract(params.url, params.instruction));
        return reply(
          `### Extracted from ${params.url}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``,
          { url: params.url, data, degraded: false, markdown: null, failure: null },
          params.format,
        );
      }),
  );
}
