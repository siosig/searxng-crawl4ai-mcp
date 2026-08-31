import pino from "pino";

/**
 * One JSON object per line, on stderr.
 *
 * stderr rather than stdout because the stdio transport puts JSON-RPC frames on
 * stdout, and a stray log line there corrupts the protocol. One object per line
 * because the log shipper this feeds later must be able to ingest it without a
 * multi-line parser.
 */
const REDACTED_PATHS = [
  "token",
  "authorization",
  "Authorization",
  "apiKey",
  "api_key",
  "geminiApiKey",
  "GEMINI_API_KEY",
  "MCP_AUTH_TOKEN",
  "SEARXNG_SECRET",
  "proxyUrl",
  "PROXY_URL",
  "*.token",
  "*.authorization",
  "*.apiKey",
  "req.headers.authorization",
];

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    // Credentials must never reach a log line, an error response or a
    // diagnostic dump - including when someone logs a whole config object.
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    // pino stamps every line with the machine's hostname and pid by default.
    // Neither helps here - there is one process on one host - and the hostname
    // is exactly the kind of environment detail that should not travel with
    // logs into a shared collector.
    base: null,
    formatters: {
      level: (label) => ({ level: label }),
    },
  },
  pino.destination(2),
);

export type Logger = typeof logger;
