import { test } from "node:test";
import assert from "node:assert/strict";
import { documentsFor, toDocument } from "../../src/upstream/crawl4ai.js";

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
