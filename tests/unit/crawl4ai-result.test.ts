import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { crawl, documentsFor, toDocument } from "../../src/upstream/crawl4ai.js";
import { LOGIN_MARKER_FILE, SESSION_ROOT_FILE } from "../../src/upstream/login-session.js";
import { setEnvForTest, type Env } from "../../src/utils/env.js";
import { UpstreamError } from "../../src/utils/errors.js";

/**
 * How a Crawl4AI result becomes a document.
 *
 * The shapes are the ones Crawl4AI 0.9.2 streams, trimmed to the fields that
 * decide the outcome. The veto message is copied from a live response.
 */

const MISSING = "https://example.test/missing";
const TINY = "https://example.test/version";
const VETO =
  "Blocked by anti-bot protection: Structural: minimal_text on small page (159 bytes, 7 chars visible)";

test("a page the target does not have reports the target's 404, not a backend error", () => {
  const doc = toDocument(
    {
      url: MISSING,
      success: false,
      status_code: 404,
      error_message: VETO,
      markdown: { raw_markdown: "\n```\n404: Not Found\n```\n" },
    },
    MISSING,
  );
  assert.equal(doc.status, "failed");
  assert.equal(doc.failure?.kind, "httpError");
  assert.equal(doc.failure?.upstreamStatus, 404);
  assert.equal(doc.failure?.message, "The target answered 404.");
});

test("a short page that answered 200 is content, whatever the structural heuristic says", () => {
  const body = "\n```\n1.100.0\n\n```\n\n";
  const doc = toDocument(
    {
      url: TINY,
      success: false,
      status_code: 200,
      error_message: VETO,
      markdown: { raw_markdown: body, fit_markdown: body },
    },
    TINY,
    "fit",
  );
  assert.equal(doc.status, "ok", JSON.stringify(doc.failure));
  assert.match(String(doc.markdown), /1\.100\.0/);
  assert.equal(doc.failure, null);
});

test("the structural verdict still fails a page with nothing in it", () => {
  const doc = toDocument(
    {
      url: TINY,
      success: false,
      status_code: 200,
      error_message: VETO,
      markdown: { raw_markdown: "\n```\n\n```\n" },
    },
    TINY,
  );
  assert.equal(doc.status, "failed");
  assert.equal(doc.failure?.message, "The page produced no readable content.");
});

const PRIVATE = "https://example.test/private/doc";
const SIGN_IN = "https://example.test/login?return_to=%2Fprivate%2Fdoc&session=abc123";

test("a page that ended on a sign-in page is a lost login, not content", () => {
  const doc = toDocument(
    {
      url: PRIVATE,
      redirected_url: SIGN_IN,
      success: true,
      status_code: 200,
      markdown: { raw_markdown: "# Sign in\n\nEmail\n\nPassword\n" },
      metadata: { title: "Sign in" },
    },
    PRIVATE,
  );
  assert.equal(doc.status, "failed");
  assert.equal(doc.failure?.kind, "loginRequired");
  assert.equal(doc.markdown, null);
  assert.equal(doc.finalUrl, SIGN_IN);
  const message = String(doc.failure?.message);
  assert.match(message, /https:\/\/example\.test\/login/);
  // The query of a sign-in address can carry tokens; it never reaches the message.
  assert.ok(!message.includes("return_to"), message);
  assert.ok(!message.includes("abc123"), message);
  assert.ok(!message.includes("?"), message);
});

test("a page that stayed where it was asked for is content as before", () => {
  const doc = toDocument(
    {
      url: PRIVATE,
      redirected_url: PRIVATE,
      success: true,
      status_code: 200,
      markdown: { raw_markdown: "# Private doc\n\nBody text.\n" },
      metadata: { title: "Private doc" },
    },
    PRIVATE,
  );
  assert.equal(doc.status, "ok", JSON.stringify(doc.failure));
  assert.equal(doc.failure, null);
  assert.equal(doc.title, "Private doc");
});

test("a sign-in page vetoed as too short is still a lost login", () => {
  // What Crawl4AI really returns for a redirect to a small sign-in form: the
  // redirect leaves status_code at 302 and the page trips the content veto.
  const doc = toDocument(
    {
      url: PRIVATE,
      redirected_url: SIGN_IN,
      success: false,
      status_code: 302,
      error_message: VETO,
      markdown: { raw_markdown: "# Sign in\n" },
    },
    PRIVATE,
  );
  assert.equal(doc.status, "failed");
  assert.equal(doc.failure?.kind, "loginRequired");
  assert.equal(doc.failure?.upstreamStatus, 302);
});

test("a failed fetch keeps its own failure kind even when it ended on a sign-in page", () => {
  const doc = toDocument(
    {
      url: PRIVATE,
      redirected_url: SIGN_IN,
      success: false,
      status_code: 404,
      error_message: "Not Found",
      markdown: { raw_markdown: "" },
    },
    PRIVATE,
  );
  assert.equal(doc.status, "failed");
  assert.notEqual(doc.failure?.kind, "loginRequired");
  assert.equal(doc.failure?.kind, "httpError");
});

test("a recognised block page is reported as blocked, not as content", () => {
  const doc = toDocument(
    {
      url: TINY,
      success: false,
      status_code: 200,
      error_message: "Blocked by anti-bot protection: Cloudflare challenge form",
      markdown: { raw_markdown: "Just a moment..." },
    },
    TINY,
  );
  assert.equal(doc.status, "failed");
  assert.equal(doc.failure?.kind, "blocked");
  assert.match(String(doc.failure?.message), /Cloudflare challenge form/);
});

test("a readable read prefers the filtered markdown and falls back to the raw one", () => {
  const page = (fit: string) => ({
    url: TINY,
    success: true,
    status_code: 200,
    markdown: { raw_markdown: "RAW", fit_markdown: fit },
  });
  assert.equal(toDocument(page("FIT"), TINY, "fit").markdown, "FIT");
  assert.equal(toDocument(page(""), TINY, "fit").markdown, "RAW");
  assert.equal(toDocument(page("FIT"), TINY).markdown, "RAW", "batch reads keep trusting raw");
});

const A = "https://example.test/a";
const B = "https://example.test/b";
const ok = (url: string, text: string) => ({
  url,
  success: true,
  status_code: 200,
  markdown: { raw_markdown: text },
});

test("stream lines are matched to the requested URLs, in the order asked", () => {
  const docs = documentsFor([A, B], [ok(B, "B"), ok(A, "A"), { status: "completed" }], "raw");
  assert.deepEqual(
    docs.map((d) => [d.url, d.markdown]),
    [
      [A, "A"],
      [B, "B"],
    ],
  );
});

test("a URL the stream never mentioned fails explicitly instead of vanishing", () => {
  const docs = documentsFor([A, B], [ok(A, "A"), { status: "completed" }], "raw");
  assert.equal(docs.length, 2);
  assert.equal(docs[1]?.status, "failed");
  assert.equal(docs[1]?.failure?.kind, "upstreamUnavailable");
});

test("a result the server could not serialise becomes that URL's failure", () => {
  const [doc] = documentsFor([A], [{ error: "boom", url: A }], "raw");
  assert.equal(doc?.status, "failed");
  assert.equal(doc?.failure?.message, "boom");
});

test("a result reported under a different spelling of its URL is still attributed", () => {
  const [doc] = documentsFor([A], [ok(`${A}/`, "A")], "raw");
  assert.equal(doc?.status, "ok");
  assert.equal(doc?.markdown, "A");
});

test("a crawl during a manual login is refused before anything leaves the process", async () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/c4ai-login-");
  fs.writeFileSync(join(dir, SESSION_ROOT_FILE), "");
  fs.writeFileSync(join(dir, LOGIN_MARKER_FILE), "login");
  // A complete upstream configuration, so that without the gate the call would
  // genuinely reach fetch - the assertion below would otherwise prove nothing.
  setEnvForTest({
    CRAWL4AI_URL: "http://crawl4ai.invalid:11235",
    CRAWL4AI_API_TOKEN: "0123456789abcdef0123456789abcdef",
    RETRY_MAX_ATTEMPTS: 1,
    LOGIN_STATE_DIR: dir,
  } as unknown as Env);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("the network must not be reached during a login");
  }) as typeof fetch;

  try {
    await assert.rejects(crawl(["http://example.invalid/"]), (error: unknown) => {
      assert.ok(error instanceof UpstreamError);
      assert.equal(error.failure.kind, "loginInProgress");
      return true;
    });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
    setEnvForTest(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
