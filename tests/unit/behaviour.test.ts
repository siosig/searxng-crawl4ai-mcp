import { test } from "node:test";
import assert from "node:assert/strict";
import { Slots } from "../../src/utils/semaphore.js";
import { hostHeaderValidationResponse, originValidationResponse } from "@modelcontextprotocol/server";
import { isAuthorized, bearerToken } from "../../src/security/auth.js";
import { UpstreamError, toFailure, failure, type ToolFailure } from "../../src/utils/errors.js";
import { reply, replyFailure } from "../../src/tools/shared.js";

test("over-budget fetches are refused, not queued", async () => {
  const slots = new Slots(1);
  let release!: () => void;
  const held = slots.run(() => new Promise<void>((r) => { release = r; }));

  // The point of refusing rather than queueing: the caller learns immediately
  // and can do something else, instead of appearing to hang.
  const started = Date.now();
  await assert.rejects(
    () => slots.run(async () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof UpstreamError);
      assert.equal(error.failure.kind, "concurrencyLimit");
      return true;
    },
  );
  assert.ok(Date.now() - started < 50, "the refusal must be immediate");

  release();
  await held;
  // The slot must come back once the work finishes.
  await slots.run(async () => undefined);
});

test("a slot is released even when the work throws", async () => {
  const slots = new Slots(1);
  await assert.rejects(() => slots.run(() => Promise.reject(new Error("boom"))));
  assert.equal(slots.inUse, 0);
  await slots.run(async () => undefined);
});

test("bearer tokens are parsed and compared exactly", () => {
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("bearer   abc"), "abc");
  assert.equal(bearerToken("Basic abc"), null);
  assert.equal(bearerToken(undefined), null);

  const secret = "a".repeat(32);
  assert.equal(isAuthorized(`Bearer ${secret}`, secret), true);
  assert.equal(isAuthorized(`Bearer ${"a".repeat(31)}b`, secret), false);
  assert.equal(isAuthorized(`Bearer ${"a".repeat(31)}`, secret), false, "a prefix must not pass");
  assert.equal(isAuthorized(undefined, secret), false);
  assert.equal(isAuthorized("", secret), false);
});

/**
 * Whether the SDK's validators, which src/transport/http.ts calls, admit a
 * request with these headers. The checks are the SDK's rather than ours, so
 * this pins the behaviour the listener relies on across SDK upgrades.
 */
function admitted(allowed: string[], host: string | null, origin?: string): boolean {
  const headers = new Headers();
  if (host !== null) headers.set("host", host);
  if (origin !== undefined) headers.set("origin", origin);
  const req = new Request("http://placeholder/mcp", { headers });
  return !hostHeaderValidationResponse(req, allowed) && !originValidationResponse(req, allowed);
}

test("host and origin are checked against the allow-list", () => {
  const allowed = ["mcp.example.com", "localhost"];

  assert.equal(admitted(allowed, "mcp.example.com"), true);
  assert.equal(admitted(allowed, "mcp.example.com:8443"), true, "the port is not a security property");
  assert.equal(admitted(allowed, "evil.example.net"), false);
  assert.equal(admitted(allowed, null), false, "a request without Host is refused");

  // A browser-driven rebinding attempt carries an Origin we never listed.
  assert.equal(admitted(allowed, "mcp.example.com", "https://evil.example.net"), false);
  assert.equal(admitted(allowed, "mcp.example.com", "https://mcp.example.com"), true);
  assert.equal(admitted(allowed, "mcp.example.com", "null"), false, "an opaque origin is refused");

  // Non-browser clients send no Origin at all; refusing them would break every
  // ordinary MCP client.
  assert.equal(admitted(allowed, "localhost"), true);

  assert.equal(admitted([], "localhost"), false, "an empty list allows nothing");
});

test("connection problems are classified, not lumped together", () => {
  const dns = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
  assert.equal(toFailure(dns).kind, "unreachable");

  const slow = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
  assert.equal(toFailure(slow).kind, "timeout");

  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.equal(toFailure(aborted).kind, "timeout");
});

test("a failed call is marked as one, and a successful one is not", () => {
  // Without `isError` the protocol reads a result as successful, so a body
  // that reports a failure would still arrive at the client as a success. This is
  // the flag that makes the difference visible; the message alone does not.
  const failed = replyFailure(failure("egressDenied", "nope"));
  assert.equal(failed.isError, true);
  assert.equal(
    (failed.structuredContent as { failure?: ToolFailure }).failure?.kind,
    "egressDenied",
  );
  assert.deepEqual(JSON.parse((failed.content[0] as { text: string }).text), failed.structuredContent);
  assert.equal((failed.structuredContent as { status?: string }).status, "failed");
  assert.equal((failed.structuredContent as { truncated?: boolean }).truncated, false);
  assert.equal((failed.structuredContent as { truncation?: unknown }).truncation, null);

  const ok = reply({ results: [] });
  assert.equal(ok.isError, undefined, "a successful result must not claim to be an error");
  assert.equal(
    (ok.content[0] as { text: string }).text,
    JSON.stringify({ results: [], truncated: false, truncation: null }),
  );
});

test("a partial batch is a successful call, not a failed one", () => {
  // Some URLs failing is the answer to the question that was asked, not a
  // failure to answer it. Marking it as an error would tell an agent to retry
  // the whole call when the right move is to look at which URLs came back.
  const partial = reply({ documents: [{ status: "failed" }] });
  assert.equal(partial.isError, undefined);
});
