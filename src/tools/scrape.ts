import type { McpServer } from "@modelcontextprotocol/server";
import { ScrapeInput } from "../schemas/tools.js";
import { getMarkdown } from "../upstream/crawl4ai.js";
import {
  ANNOTATIONS,
  countDocuments,
  documentMarkdown,
  egressGuard,
  fetchSlots,
  guarded,
  reply,
  replyFailure,
} from "./shared.js";

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
      guarded("web_scrape", params.format, async () => {
        const denied = await egressGuard(params.url);
        if (denied) return replyFailure(denied, params.format);

        const doc = await fetchSlots().run(() => getMarkdown(params.url));
        countDocuments([doc]);
        return reply(documentMarkdown(doc), { ...doc }, params.format);
      }),
  );
}
