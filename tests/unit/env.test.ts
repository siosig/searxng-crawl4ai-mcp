import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateEnv, setEnvForTest } from "../../src/utils/env.js";

/**
 * What configuration each entry demands of an operator.
 *
 * The interesting half of this is the negative one. Making the token and the
 * host allow-list optional in the schema is exactly the kind of change that
 * could quietly stop the HTTP entry from requiring them, and nothing else in
 * the suite would notice: an unguarded listener answers every request happily.
 * So the cases below pin both directions - what stdio is allowed to omit, and
 * what http is still refused for omitting.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENV_MODULE = new URL("../../src/utils/env.ts", import.meta.url).href;

/** Everything that is about the upstreams, and so required either way. */
const UPSTREAM = {
  SEARXNG_URL: "http://searxng:8080",
  CRAWL4AI_URL: "http://crawl4ai:11235",
  CRAWL4AI_API_TOKEN: "0123456789abcdef0123456789abcdef",
} as const;

/** What the HTTP entry needs on top, because it opens a port. */
const LISTENER = {
  MCP_AUTH_TOKEN: "0123456789abcdef0123456789abcdef",
  MCP_ALLOWED_HOSTS: "localhost,127.0.0.1",
} as const;

/**
 * Start a process whose only job is to validate the given environment.
 *
 * A child rather than a direct call because validateEnv() answers a bad
 * configuration with process.exit(1) - which is the behaviour under test, not
 * an inconvenience to work around. Stubbing the exit would test a different
 * function than the one that ships.
 */
function refusedToStart(env: Record<string, string>): { code: number; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "-e", `const m = await import(${JSON.stringify(ENV_MODULE)}); m.validateEnv();`],
    // A bare environment: inheriting this process's would let a variable that
    // happens to be set in the developer's shell decide the outcome.
    { cwd: ROOT, env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" },
  );
  return { code: result.status ?? -1, stderr: result.stderr };
}

test("the stdio entry starts with nothing that only a listener would need", () => {
  const config = validateEnv({ ...UPSTREAM, MCP_TRANSPORT: "stdio" });

  assert.equal(config.MCP_TRANSPORT, "stdio");
  assert.equal(config.MCP_AUTH_TOKEN, undefined);
  assert.equal(config.MCP_ALLOWED_HOSTS, undefined);

  // The module caches whatever validated last; leaving that behind would make
  // a later env() call in this process answer with a stdio configuration.
  setEnvForTest(null);
});

test("the upstreams stay required under stdio; only the listener's guards are dropped", () => {
  const { code, stderr } = refusedToStart({ MCP_TRANSPORT: "stdio" });

  assert.equal(code, 1, "stdio must not start without the upstreams it exists to call");
  assert.match(stderr, /SEARXNG_URL/);
  assert.match(stderr, /CRAWL4AI_URL/);
  assert.match(stderr, /CRAWL4AI_API_TOKEN/);
});

test("an unset transport is still the HTTP entry, and still refuses to start unguarded", () => {
  // The default matters as much as the explicit value: an existing deployment
  // sets no MCP_TRANSPORT at all, and it must not be the one that loses its
  // authentication because a second transport was added.
  const { code, stderr } = refusedToStart({ ...UPSTREAM });

  assert.equal(code, 1, "an unauthenticated listener started; FR-025 has been weakened");
  assert.match(stderr, /MCP_AUTH_TOKEN/);
  assert.match(stderr, /MCP_ALLOWED_HOSTS/);
});

test("http refuses to start missing either guard, one at a time", () => {
  const withoutToken = refusedToStart({
    ...UPSTREAM,
    MCP_TRANSPORT: "http",
    MCP_ALLOWED_HOSTS: LISTENER.MCP_ALLOWED_HOSTS,
  });
  assert.equal(withoutToken.code, 1);
  assert.match(withoutToken.stderr, /MCP_AUTH_TOKEN/);

  const withoutHosts = refusedToStart({
    ...UPSTREAM,
    MCP_TRANSPORT: "http",
    MCP_AUTH_TOKEN: LISTENER.MCP_AUTH_TOKEN,
  });
  assert.equal(withoutHosts.code, 1);
  assert.match(withoutHosts.stderr, /MCP_ALLOWED_HOSTS/);
});

test("a fully configured http environment still validates", () => {
  // Otherwise the tests above would pass on a schema that rejects everything.
  const config = validateEnv({ ...UPSTREAM, ...LISTENER, MCP_TRANSPORT: "http" });

  assert.equal(config.MCP_TRANSPORT, "http");
  assert.equal(config.MCP_AUTH_TOKEN, LISTENER.MCP_AUTH_TOKEN);
  assert.deepEqual(config.MCP_ALLOWED_HOSTS, ["localhost", "127.0.0.1"]);

  setEnvForTest(null);
});
