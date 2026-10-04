import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { clientFromEnv, FIXTURE, type McpClient } from "../client.js";
import { fetchMetrics } from "../metrics-client.js";

/**
 * Logins persist in the session profile (specs/006-persistent-login-sessions).
 *
 * Runs only in the CI step "Verify logins persist in the session profile",
 * against a stack started with docker/compose.login-session.yaml and a
 * prepared LOGIN_SESSION_ROOT. Set LOGIN_SESSION_CONTRACT=1 and COMPOSE_ARGS
 * (the whole `--env-file ... -f ...` list, space separated) to run it.
 *
 * The tests restart crawl4ai and change files in the session store, so they
 * depend on running one after another in this order; node:test runs the tests
 * of one file in sequence. Each test puts back what it changed in `finally`.
 */

const enabled = process.env.LOGIN_SESSION_CONTRACT === "1";
const skip = enabled ? false : "set LOGIN_SESSION_CONTRACT=1 on a stack started with the login session overlay";

/** Long enough for a rebuild check and a cold Chromium start, short of hanging the job. */
const COMPOSE_TIMEOUT_MS = 10 * 60 * 1000;

const SESSION_ROOT_FILE = "/session/state/.session-root";
const LOGIN_MARKER_FILE = "/session/state/login-in-progress";

/** Created on first use, so a skipped run needs no MCP_AUTH_TOKEN. */
let mcp: McpClient | undefined;
function client(): McpClient {
  mcp ??= clientFromEnv();
  return mcp;
}

function compose(...rest: string[]): string {
  const args = process.env.COMPOSE_ARGS;
  if (!args) throw new Error("COMPOSE_ARGS must be set to the compose arguments of the running stack");
  try {
    return execFileSync("docker", ["compose", ...args.split(" ").filter(Boolean), ...rest], {
      stdio: "pipe",
      encoding: "utf8",
      timeout: COMPOSE_TIMEOUT_MS,
    });
  } catch (error) {
    const e = error as { status?: number | null; stderr?: string };
    throw new Error(`docker compose ${rest.join(" ")} exited ${e.status ?? "abnormally"}: ${e.stderr ?? ""}`, {
      cause: error,
    });
  }
}

/**
 * Runs one command in a throwaway crawl4ai container, as its appuser, which
 * owns state/. Overriding the entrypoint skips crawl4ai's start script, so this
 * works even while .session-root is missing.
 */
function inCrawl4ai(entrypoint: string, ...args: string[]): string {
  return compose("run", "--rm", "--no-deps", "-T", "--entrypoint", entrypoint, "crawl4ai", ...args);
}

function markLogin(): void {
  inCrawl4ai("sh", "-c", `printf 'login\\n' > ${LOGIN_MARKER_FILE}`);
}

function unmarkLogin(): void {
  inCrawl4ai("sh", "-c", `rm -f ${LOGIN_MARKER_FILE}`);
}

function restoreSessionRoot(): void {
  inCrawl4ai("touch", SESSION_ROOT_FILE);
}

/**
 * Chromium writes cookies to disk on a timer (about every 30 seconds), not as
 * they arrive, so a stop that comes sooner can lose them. Wait until the probe
 * cookie is in the profile's Cookies database before stopping anything; this
 * reads the file from a throwaway container, read-only, and never opens it in
 * a browser.
 */
async function waitForCookieOnDisk(name: string, timeoutMs = 90_000): Promise<void> {
  const query =
    "import sqlite3,sys\n" +
    "try:\n" +
    " c=sqlite3.connect('file:/session/profile/Default/Cookies?mode=ro',uri=True)\n" +
    ` print("COOKIES=%d" % c.execute("select count(*) from cookies where name=?",("${name}",)).fetchone()[0])\n` +
    "except Exception:\n" +
    " print('COOKIES=0')\n";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Read the count from its own marked line: `compose run` can put other
    // lines on stdout, and anything but an explicit positive count is "not yet".
    const found = /COOKIES=(\d+)/.exec(inCrawl4ai("python", "-c", query));
    if (found && Number(found[1]) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`${name} never reached the profile's Cookies database within ${timeoutMs} ms`);
}

interface Failure {
  kind?: string;
  message?: string;
}

test("a cookie set in one crawl is sent in the next, after crawl4ai is recreated", { skip }, async () => {
  const n = randomUUID();

  const set = await client().call("web_scrape", { url: `${FIXTURE}/session/set?n=${n}` });
  assert.equal(set.structured.status, "ok", JSON.stringify(set.structured.failure));

  await waitForCookieOnDisk("c4ai_session_probe");

  // Stop it cleanly first so Chromium writes its cookies out, then recreate:
  // the new container has a new host name, which also proves the stale
  // SingletonLock left in the profile is cleared on start.
  compose("stop", "-t", "60", "crawl4ai");
  compose("up", "-d", "--force-recreate", "--wait", "--wait-timeout", "300", "crawl4ai");

  const check = await client().call("web_scrape", { url: `${FIXTURE}/session/check?n=${n}` });
  assert.equal(check.structured.status, "ok", JSON.stringify(check.structured.failure));
  // Tolerates a Markdown converter that escapes the brackets.
  assert.match(
    String(check.structured.markdown),
    /probe=\\?\[ok\\?\]/,
    `the cookie did not survive the restart: ${String(check.structured.markdown)}`,
  );
});

test("while a login is in progress, fetching answers loginInProgress", { skip }, async () => {
  try {
    markLogin();

    const during = await client().call("web_scrape", { url: `${FIXTURE}/index.html` });
    const reason = during.structured.failure as Failure | null;
    assert.equal(during.structured.status, "failed");
    assert.equal(reason?.kind, "loginInProgress", JSON.stringify(reason));

    unmarkLogin();

    const after = await client().call("web_scrape", { url: `${FIXTURE}/index.html` });
    assert.equal(after.structured.status, "ok", JSON.stringify(after.structured.failure));
  } finally {
    unmarkLogin();
  }
});

test("the metrics report that logins are kept", { skip }, async () => {
  const text = await fetchMetrics();
  assert.match(text, /^mcp_login_session_enabled 1$/m);
});

test("crawl4ai refuses to start without the session marker file", { skip }, async () => {
  try {
    inCrawl4ai("rm", "-f", SESSION_ROOT_FILE);

    // The MCP server reads the same file through its read-only mount of state/,
    // so it refuses before it reaches crawl4ai at all.
    const scrape = await client().call("web_scrape", { url: `${FIXTURE}/index.html` });
    const reason = scrape.structured.failure as Failure | null;
    assert.equal(scrape.structured.status, "failed");
    assert.equal(reason?.kind, "upstreamUnavailable", JSON.stringify(reason));

    assert.throws(
      () => compose("up", "-d", "--force-recreate", "--wait", "--wait-timeout", "60", "crawl4ai"),
      Error,
      "crawl4ai must not become healthy without the marker file",
    );

    const logs = compose("logs", "--no-color", "--tail", "200", "crawl4ai");
    assert.match(logs, /\.session-root is missing/);
  } finally {
    restoreSessionRoot();
    // Recreated rather than left to the restart policy, whose back-off can
    // outlast the wait.
    compose("up", "-d", "--force-recreate", "--wait", "--wait-timeout", "300", "crawl4ai");
  }
});
