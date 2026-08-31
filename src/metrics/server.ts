import { createServer, type Server } from "node:http";
import { registry } from "./registry.js";
import { enableMetrics } from "./record.js";
import { logger } from "../utils/logger.js";

/**
 * The metrics listener.
 *
 * There is no authentication here. The protection is that nothing outside the
 * host can route to it - which means the binding matters, and what "loopback"
 * means depends on where this runs:
 *
 *   - Directly on a host: binding 127.0.0.1 is the whole story.
 *   - In a container: 127.0.0.1 is the *container's* loopback, which a
 *     collector on the host cannot reach at all (verified: the connection is
 *     reset). There the process binds all interfaces and Docker publishes the
 *     port to the host's loopback only, which is what actually keeps it off
 *     the network.
 *
 * Hence METRICS_HOST. Guessing which situation applies would be the same kind
 * of implicit assumption that this project keeps getting bitten by.
 *
 * Keeping this on its own port rather than adding a path to the main server is
 * deliberate. The reverse proxy in front of the MCP port matches its location
 * exactly today; the day someone loosens that, a `/metrics` path on the same
 * port becomes public. A separate port has no such failure mode.
 */

/**
 * Start the metrics listener, if a port is configured.
 *
 * Returns null when metrics are off - and when they are off, no server is
 * created at all. Not "created but idle": a deployment without monitoring opens
 * no extra port.
 *
 * A failure to listen is logged and swallowed. Metrics are an optional extra,
 * and taking the whole server down because a metrics port was already in use
 * would invert that completely.
 */
export function startMetricsServer(
  port: number | undefined,
  host: string,
): Server | null {
  if (port === undefined) {
    logger.info("metrics disabled (METRICS_PORT is not set)");
    return null;
  }

  const server = createServer((req, res) => {
    if (req.method !== "GET" || (req.url ?? "/").split("?")[0] !== "/metrics") {
      res.writeHead(404).end();
      return;
    }
    registry
      .metrics()
      .then((body) => {
        res.writeHead(200, { "content-type": registry.contentType });
        res.end(body);
      })
      .catch((error: unknown) => {
        logger.warn({ err: error }, "failed to render metrics");
        res.writeHead(500).end();
      });
  });

  server.on("error", (error) => {
    logger.warn({ err: error }, "metrics listener failed; continuing without it");
  });

  server.listen(port, host, () => {
    enableMetrics();
    logger.info({ port, host }, "metrics listening");
  });

  return server;
}
