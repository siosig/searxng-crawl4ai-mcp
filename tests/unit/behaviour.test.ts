import { test } from "node:test";
import assert from "node:assert/strict";
import { Slots } from "../../src/utils/semaphore.js";
import { truncate } from "../../src/utils/format.js";
import { isAuthorized, isOriginAllowed, bearerToken } from "../../src/security/auth.js";
import { UpstreamError, toFailure, failure, type ToolFailure } from "../../src/utils/errors.js";
import { reply, replyFailure } from "../../src/tools/shared.js";
import { CHARACTER_LIMIT } from "../../src/constants.js";

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

test("oversized output is cut and says so", () => {
  const small = truncate("short");
  assert.equal(small.truncated, false);
  assert.equal(small.text, "short");

  const big = truncate("x".repeat(CHARACTER_LIMIT + 5_000));
  assert.equal(big.truncated, true);
  assert.ok(big.text.length <= CHARACTER_LIMIT);
  assert.match(big.text, /truncated/, "a cut response must announce itself");
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

test("host and origin are checked against the allow-list", () => {
  const allowed = ["mcp.example.com", "localhost"];

  assert.equal(isOriginAllowed("mcp.example.com", undefined, allowed), true);
  assert.equal(isOriginAllowed("mcp.example.com:8443", undefined, allowed), true, "the port is not a security property");
  assert.equal(isOriginAllowed("evil.example.net", undefined, allowed), false);

  // A browser-driven rebinding attempt carries an Origin we never listed.
  assert.equal(isOriginAllowed("mcp.example.com", "https://evil.example.net", allowed), false);
  assert.equal(isOriginAllowed("mcp.example.com", "https://mcp.example.com", allowed), true);

  // Non-browser clients send no Origin at all; refusing them would break every
  // ordinary MCP client.
  assert.equal(isOriginAllowed("localhost", undefined, allowed), true);

  assert.equal(isOriginAllowed("localhost", undefined, []), false, "an empty list allows nothing");
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
  // that says "Failed" would still arrive at the client as a success. This is
  // the flag that makes the difference visible; the message alone does not.
  const failed = replyFailure(failure("egressDenied", "nope"), "markdown");
  assert.equal(failed.isError, true);
  assert.equal(
    (failed.structuredContent as { failure?: ToolFailure }).failure?.kind,
    "egressDenied",
  );

  const ok = reply("all good", { results: [] }, "markdown");
  assert.equal(ok.isError, undefined, "a successful result must not claim to be an error");
});

test("a partial batch is a successful call, not a failed one", () => {
  // Some URLs failing is the answer to the question that was asked, not a
  // failure to answer it. Marking it as an error would tell an agent to retry
  // the whole call when the right move is to look at which URLs came back.
  const partial = reply("1 of 2 pages fetched.", { documents: [{ status: "failed" }] }, "markdown");
  assert.equal(partial.isError, undefined);
});
