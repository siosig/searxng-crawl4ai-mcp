import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { buildServer, SERVER_NAME, SERVER_VERSION } from "../server.js";
import { isAuthorized } from "../security/auth.js";
import { httpConfig } from "../utils/env.js";
import { logger } from "../utils/logger.js";

const MCP_PATH = "/mcp";

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text).toString(),
  });
  res.end(text);
}

/**
 * Turn a Node request's headers into the web-standard Request the SDK's
 * host and origin validators expect. Only the parts they read are needed.
 */
function asWebRequest(req: IncomingMessage): Request {
  const host = header(req, "host") ?? "localhost";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  return new Request(`http://${host}${req.url ?? "/"}`, {
    method: "GET",
    headers,
  });
}

export function startHttpServer(): Server {
  // Narrowed here rather than read from env() directly: the token and the
  // host allow-list are optional in the schema because the stdio entry has no
  // use for them, and this entry must not carry that uncertainty around.
  const config = httpConfig();
  const handler = createMcpHandler(() => buildServer(), {
    onerror: (error) => logger.error({ err: error }, "MCP handler error"),
  });
  const nodeHandler = toNodeHandler(handler);

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    // Unauthenticated information route. Deliberately says nothing about
    // configuration - just enough for a health probe to see a live process.
    if (path === "/" && req.method === "GET") {
      send(res, 200, { name: SERVER_NAME, version: SERVER_VERSION, status: "ok" });
      return;
    }

    if (path !== MCP_PATH) {
      send(res, 404, { error: "not_found" });
      return;
    }

    // DNS-rebinding protection, using the SDK's own validators so this server
    // does not drift from the transport's expectations.
    const webRequest = asWebRequest(req);
    const badHost = hostHeaderValidationResponse(webRequest, config.MCP_ALLOWED_HOSTS);
    if (badHost) {
      logger.warn({ host: header(req, "host") }, "rejected: host not allowed");
      send(res, badHost.status, { error: "host_not_allowed" });
      return;
    }
    const badOrigin = originValidationResponse(webRequest, config.MCP_ALLOWED_HOSTS);
    if (badOrigin) {
      logger.warn({ origin: header(req, "origin") }, "rejected: origin not allowed");
      send(res, badOrigin.status, { error: "origin_not_allowed" });
      return;
    }

    if (!isAuthorized(header(req, "authorization"), config.MCP_AUTH_TOKEN)) {
      logger.warn({ path }, "rejected: bad or missing bearer token");
      res.setHeader("www-authenticate", 'Bearer realm="mcp"');
      send(res, 401, { error: "unauthorized" });
      return;
    }

    // `exactOptionalPropertyTypes` makes Node's `IncomingMessage` (whose
    // `method` is `string | undefined`) structurally incompatible with the
    // adapter's duck-typed parameter, even though the adapter is written to
    // accept exactly this object. The cast is confined to this one call.
    void nodeHandler(req as Parameters<typeof nodeHandler>[0], res);
  });

  server.listen(config.PORT, () => {
    logger.info({ port: config.PORT, path: MCP_PATH }, "MCP server listening");
  });

  // Graceful shutdown: stop accepting, let in-flight exchanges finish, then
  // let the handler tear down its per-request instances.
  const shutdown = (signal: string): void => {
    logger.info({ signal }, "shutting down");
    server.close(() => {
      void handler.close().finally(() => process.exit(0));
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return server;
}
