import { validateEnv } from "./utils/env.js";
import { startHttpServer } from "./transport/http.js";
import { startMetricsServer } from "./metrics/server.js";
import { logger } from "./utils/logger.js";

// Validate before anything else touches configuration. A server that starts
// with a broken environment and fails on the first tool call is much harder to
// diagnose than one that refuses to start and says which variable is wrong.
const config = validateEnv();

try {
  startHttpServer();
} catch (error) {
  logger.fatal({ err: error }, "failed to start");
  process.exit(1);
}

// After the server that matters, and outside its try/catch. Metrics are an
// optional extra: if this cannot start, the tools still can, and that ordering
// is the point rather than an accident.
startMetricsServer(config.METRICS_PORT, config.METRICS_HOST);
