import { validateEnv } from "./utils/env.js";
import { startHttpServer } from "./transport/http.js";
import { startStdioServer } from "./transport/stdio.js";
import { startMetricsServer } from "./metrics/server.js";
import { logger } from "./utils/logger.js";

// Validate before anything else touches configuration. A server that starts
// with a broken environment and fails on the first tool call is much harder to
// diagnose than one that refuses to start and says which variable is wrong.
const config = validateEnv();

// One process, two front doors onto the same tools. The branch is here rather
// than in two entry files so that everything below - and everything behind
// buildServer() - stays shared by construction.
try {
  if (config.MCP_TRANSPORT === "stdio") {
    startStdioServer();
  } else {
    startHttpServer();
  }
} catch (error) {
  logger.fatal({ err: error }, "failed to start");
  process.exit(1);
}

// After the server that matters, and outside its try/catch. Metrics are an
// optional extra: if this cannot start, the tools still can, and that ordering
// is the point rather than an accident.
//
// Only for the listening entry, though. A stdio process is started by its
// client, once per client, and several clients on one machine run several of
// them at the same time - so a fixed metrics port is not a port this process
// can claim. Whoever is second would be scraping a listener that belongs to
// someone else's process. Scraping the stdio entry needs a per-process port,
// which is a different design than the one variable here can express, so it
// stays unimplemented rather than half-implemented.
if (config.MCP_TRANSPORT === "http") {
  startMetricsServer(config.METRICS_PORT, config.METRICS_HOST);
}
