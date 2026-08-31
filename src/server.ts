import { McpServer } from "@modelcontextprotocol/server";
import { registerSearchTool } from "./tools/search.js";
import { registerScrapeTool } from "./tools/scrape.js";
import { registerSearchAndScrapeTool } from "./tools/search-and-scrape.js";
import { registerBatchScrapeTool } from "./tools/batch-scrape.js";
import { registerCrawlTool } from "./tools/crawl.js";
import { registerMapTool } from "./tools/map.js";
import { registerExtractTool } from "./tools/extract.js";
import { registerJobStatusTool } from "./tools/job-status.js";

export const SERVER_NAME = "searxng-crawl4ai-mcp-server";
export const SERVER_VERSION = "0.1.0";

/**
 * Build a server instance for one connection.
 *
 * The SDK asks for a factory rather than an instance, and registration happens
 * inside it on purpose: registering at module scope would give every
 * connection the same object, so per-connection state - subscriptions,
 * logging level, in-flight requests - would leak between clients.
 *
 * Keeping the tool list here rather than relying on import side effects also
 * means this file answers "what does this server expose?" on its own.
 */
export function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerSearchTool(server);
  registerScrapeTool(server);
  registerSearchAndScrapeTool(server);
  registerBatchScrapeTool(server);
  registerCrawlTool(server);
  registerMapTool(server);
  registerExtractTool(server);
  registerJobStatusTool(server);

  return server;
}

/** Names of every tool this server exposes. Used by the contract tests. */
export const TOOL_NAMES = [
  "web_search",
  "web_scrape",
  "web_search_and_scrape",
  "web_batch_scrape",
  "web_crawl",
  "web_map",
  "web_extract",
  "web_job_status",
] as const;
