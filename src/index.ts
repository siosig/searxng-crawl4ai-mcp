import { validateEnv } from "./utils/env.js";
import { startHttpServer } from "./transport/http.js";
import { logger } from "./utils/logger.js";

// Validate before anything else touches configuration. A server that starts
// with a broken environment and fails on the first tool call is much harder to
// diagnose than one that refuses to start and says which variable is wrong.
validateEnv();

try {
  startHttpServer();
} catch (error) {
  logger.fatal({ err: error }, "failed to start");
  process.exit(1);
}
