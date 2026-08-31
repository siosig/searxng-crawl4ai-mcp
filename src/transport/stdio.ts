import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "../server.js";
import { logger } from "../utils/logger.js";

/**
 * The stdio entry.
 *
 * The client owns this process: it spawns it, speaks JSON-RPC over the pipes,
 * and kills it when the session ends. Nothing listens on a port, which is why
 * none of the HTTP entry's defences appear here - a bearer token and a Host
 * allow-list guard a listener, and there is no listener to guard. Everything
 * that is about the tools themselves - the outbound policy, the fetch budget,
 * the output cap, failures returned as values - is unchanged, because it lives
 * behind buildServer() rather than in front of it.
 *
 * The same factory as the HTTP entry, deliberately: two factories would be two
 * tool lists, and the two would drift apart the first time someone added a
 * tool to one of them.
 */
export function startStdioServer(): StdioServerHandle {
  const handle = serveStdio(() => buildServer(), {
    // Reporting only - it never changes what goes on the wire. It reaches
    // stderr because that is where the logger writes; stdout carries the
    // protocol here, and one stray line on it corrupts the session.
    onerror: (error) => logger.error({ err: error }, "MCP stdio error"),
  });

  // Says on stderr what the HTTP entry says on start-up. Not decoration: it is
  // the only signal an operator debugging a client's spawn configuration gets
  // that this process reached a serving state rather than dying quietly, and
  // it is what makes "diagnostics go to stderr" observable rather than assumed.
  logger.info({ transport: "stdio" }, "MCP server ready on stdio");

  // Graceful shutdown, matching the HTTP entry: close first, then exit, so the
  // pinned server instance gets to release what it holds instead of being cut
  // off mid-teardown. A client that kills the process outright skips this, but
  // an operator sending a signal by hand should not have to.
  const shutdown = (signal: string): void => {
    logger.info({ signal }, "shutting down");
    void handle.close().finally(() => process.exit(0));
    // Do not hang forever on a teardown that never settles.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return handle;
}
