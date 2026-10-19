import type { McpServer } from "@modelcontextprotocol/server";
import { ScrapeInput } from "../schemas/tools.js";
import { getMarkdown } from "../upstream/crawl4ai.js";
import type { TrimStep } from "../utils/fit.js";
import {
  ANNOTATIONS,
  countDocuments,
  egressGuard,
  fetchSlots,
  guarded,
  reply,
  replyFailure,
} from "./shared.js";

/**
 * A single page has only its markdown to give up, so that is the one thing
 * cut when the reply is over the limit.
 */
export const SCRAPE_STEPS: readonly TrimStep[] = [{ kind: "text", path: "/markdown" }];

export function registerScrapeTool(server: McpServer): void {
  server.registerTool(
    "web_scrape",
    {
      title: "Fetch a page as markdown",
      description:
        "Fetch one web page and return its readable content as markdown, with scripts, navigation " +
        "and boilerplate removed. Renders JavaScript, so it works on pages a plain HTTP fetch cannot read. " +
        "Targets on private, loopback or link-local addresses are refused; that refusal is reported " +
        "distinctly from a site being unreachable.",
      inputSchema: ScrapeInput,
      annotations: ANNOTATIONS,
    },
    async (params) =>
      guarded("web_scrape", async () => {
        const denied = await egressGuard(params.url);
        if (denied) return replyFailure(denied);

        const doc = await fetchSlots().run(() => getMarkdown(params.url, { keepLinks: params.keepLinks }));
        countDocuments([doc]);
        // The one page asked for is the whole call, so its failure is the call's.
        if (doc.status === "failed") return replyFailure(doc.failure!);
        return reply({ ...doc }, SCRAPE_STEPS, params.maxChars);
      }),
  );
}
