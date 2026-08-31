import * as z from "zod/v4";
import {
  DEFAULT_MAX_CONCURRENT_FETCHES,
  DEFAULT_PORT,
  DEFAULT_RETRY_ATTEMPTS,
} from "../constants.js";

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

const BaseEnvSchema = z.object({
  // --- How this process talks to its client. ---

  // Two entries, not two builds: both serve the same tools from the same
  // buildServer() factory, and they differ only in what sits in front of it.
  //
  //   http  - a listener, so a token and a Host allow-list are what stand
  //           between the tools and anyone who can reach the port.
  //   stdio - the client owns the process and speaks over its pipes. There is
  //           no listener, so there is nothing for a token to protect; asking
  //           for one would be a ritual rather than a control.
  //
  // Chosen through the environment like every other setting here. A command
  // line flag would be a second place to configure this server, and the two
  // would eventually disagree.
  MCP_TRANSPORT: z.enum(["http", "stdio"]).default("http"),

  // --- Required. Absence is a startup failure, never a permissive default. ---

  // Without a token the server would be an open scraping proxy for anyone who
  // can reach the port, so an unset value must stop the process rather than
  // start it unauthenticated. Optional *here* only so that the stdio entry,
  // which opens no port, is not made to invent one; the refinement below still
  // makes it mandatory whenever there is a port to defend.
  MCP_AUTH_TOKEN: z
    .string()
    .min(16, "MCP_AUTH_TOKEN must be at least 16 characters")
    .optional(),

  // DNS-rebinding protection. An empty list would allow every Host.
  MCP_ALLOWED_HOSTS: csv
    .refine((hosts) => hosts.length > 0, "MCP_ALLOWED_HOSTS must list at least one hostname")
    .optional(),

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

  // Attempts against an upstream, including the first. 1 - or 0, read the same
  // way - turns retrying off entirely, which is the escape hatch for an
  // operator who would rather see every transient failure than have them
  // absorbed.
  //
  // The ceiling is 5 because the wait budget in src/constants.ts stops a sixth
  // attempt from ever being reached; allowing a larger number would only
  // suggest an effect it cannot have.
  RETRY_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(0)
    .max(5)
    .default(DEFAULT_RETRY_ATTEMPTS),

  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),

  // Metrics are entirely optional. Unset means no metrics listener is created
  // at all - not "created but idle" - so a deployment with no monitoring
  // stack opens no extra port and pays nothing. Nothing else in the server
  // depends on this being set.
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).optional(),

  // Where the metrics listener binds.
  //
  // The default is loopback, which is right when this process runs directly on
  // a host. Inside a container it is wrong: a container's loopback is its own,
  // so a collector on the host cannot reach it - verified by trying, and the
  // connection is reset. There, the isolation comes from publishing the port to
  // the host's loopback only, and the process binds all interfaces so that
  // publishing has something to forward to.
  //
  // Left configurable rather than guessed, because detecting "am I in a
  // container?" is exactly the kind of implicit assumption that breaks on a
  // machine unlike the one it was written on.
  METRICS_HOST: z.string().min(1).default("127.0.0.1"),
});

/**
 * The two settings that only mean something when there is a listener.
 *
 * Enforced here rather than in the field definitions because whether they are
 * required is a fact about the transport, not about the fields. Writing it as a
 * refinement keeps the requirement in one readable place and keeps the failure
 * where every other configuration failure already happens: at startup, naming
 * the variable.
 */
const EnvSchema = BaseEnvSchema.superRefine((value, ctx) => {
  if (value.MCP_TRANSPORT !== "http") return;

  if (value.MCP_AUTH_TOKEN === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["MCP_AUTH_TOKEN"],
      message:
        "MCP_AUTH_TOKEN is required when MCP_TRANSPORT is http; without it the " +
        "listener would be an open scraping proxy",
    });
  }

  if (value.MCP_ALLOWED_HOSTS === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["MCP_ALLOWED_HOSTS"],
      message:
        "MCP_ALLOWED_HOSTS is required when MCP_TRANSPORT is http; without it " +
        "every Host header would be accepted",
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * The listener's settings, with the two conditional ones narrowed.
 *
 * `MCP_AUTH_TOKEN` and `MCP_ALLOWED_HOSTS` are optional in the schema because
 * the stdio entry does not need them, which leaves them `string | undefined`
 * for every reader. Rather than scatter assertions through the HTTP transport,
 * the narrowing happens once, here, next to the refinement that guarantees it.
 *
 * Throwing is unreachable in practice: validateEnv() has already refused to
 * start a http process without these. It is a guard against a future caller
 * reaching for this from the stdio path, not a runtime condition to handle.
 */
export function httpConfig(): {
  readonly MCP_AUTH_TOKEN: string;
  // Mutable rather than readonly: the SDK's host and origin validators take a
  // `string[]`, and widening their signature is not ours to do.
  readonly MCP_ALLOWED_HOSTS: string[];
  readonly PORT: number;
} {
  const config = env();
  if (config.MCP_AUTH_TOKEN === undefined || config.MCP_ALLOWED_HOSTS === undefined) {
    throw new Error(
      "httpConfig() was called without the HTTP transport's settings; " +
        "this path is only reachable when MCP_TRANSPORT is http",
    );
  }
  return {
    MCP_AUTH_TOKEN: config.MCP_AUTH_TOKEN,
    MCP_ALLOWED_HOSTS: config.MCP_ALLOWED_HOSTS,
    PORT: config.PORT,
  };
}

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
