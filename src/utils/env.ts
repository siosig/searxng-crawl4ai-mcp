import * as z from "zod/v4";
import { DEFAULT_MAX_CONCURRENT_FETCHES, DEFAULT_PORT } from "../constants.js";

/**
 * Configuration, validated once at startup.
 *
 * Everything here is environment-specific and arrives from outside the
 * repository. Nothing in this file may carry a default that is a credential.
 */

const csv = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );

const optionalNonEmpty = z
  .string()
  .transform((s) => s.trim())
  .transform((s) => (s === "" ? undefined : s))
  .optional();

const EnvSchema = z.object({
  // --- Required. Absence is a startup failure, never a permissive default. ---

  // Without a token the server would be an open scraping proxy for anyone who
  // can reach the port, so an unset value must stop the process rather than
  // start it unauthenticated.
  MCP_AUTH_TOKEN: z
    .string()
    .min(16, "MCP_AUTH_TOKEN must be at least 16 characters"),

  // DNS-rebinding protection. An empty list would allow every Host.
  MCP_ALLOWED_HOSTS: csv.refine(
    (hosts) => hosts.length > 0,
    "MCP_ALLOWED_HOSTS must list at least one hostname",
  ),

  SEARXNG_URL: z.url("SEARXNG_URL must be a URL"),
  CRAWL4AI_URL: z.url("CRAWL4AI_URL must be a URL"),

  // Not just a credential. Crawl4AI binds gunicorn to loopback when this is
  // unset, which makes it unreachable from this container while still
  // reporting healthy from the inside - so a missing value has to stop us
  // here rather than surface later as a confusing connection refusal.
  CRAWL4AI_API_TOKEN: z
    .string()
    .min(16, "CRAWL4AI_API_TOKEN must be at least 16 characters"),

  // --- Optional. Sensible behaviour when unset. ---

  PORT: z.coerce.number().int().positive().default(DEFAULT_PORT),

  // No key means web_extract returns page markdown instead of structured
  // fields. Every other tool is unaffected, so this must stay optional.
  GEMINI_API_KEY: optionalNonEmpty,
  GEMINI_MODEL: z
    .string()
    .transform((s) => s.trim())
    .default("gemini/gemini-flash-lite-latest"),

  // Unset means connect directly. When set, it applies to every outbound call.
  PROXY_URL: optionalNonEmpty,

  // Widens the outbound policy. It can never narrow it - the denied ranges are
  // compiled in and are not reachable from configuration.
  SCRAPE_ALLOW_CIDRS: csv.default([]),

  // A browser per slot. Low-power hosts should lower this.
  MAX_CONCURRENT_FETCHES: z.coerce
    .number()
    .int()
    .min(1)
    .max(32)
    .default(DEFAULT_MAX_CONCURRENT_FETCHES),

  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * Validate the environment and fail fast.
 *
 * Reported on stderr and then `process.exit(1)`: a server that starts with a
 * broken configuration and fails on the first tool call is far harder to
 * diagnose than one that refuses to start and says why.
 *
 * The error text deliberately names only the offending variables, never their
 * values.
 */
export function validateEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Treat "" as absent: compose interpolates unset variables to empty strings,
  // so an unset optional would otherwise fail as "present but invalid".
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() !== "") cleaned[key] = value;
  }

  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    process.stderr.write(
      `Configuration is invalid, refusing to start:\n${issues}\n` +
        `See .env.example for the full list of variables.\n`,
    );
    process.exit(1);
  }

  cached = result.data;
  return cached;
}

/** The validated environment. Throws if `validateEnv` has not run yet. */
export function env(): Env {
  if (cached === null) {
    throw new Error("validateEnv() must be called before env()");
  }
  return cached;
}

/** Test seam: install a configuration without touching process.env. */
export function setEnvForTest(value: Env | null): void {
  cached = value;
}
