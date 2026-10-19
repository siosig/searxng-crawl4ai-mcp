/**
 * Runs each tool's own trim steps over an oversized result and checks what
 * comes out of `reply`.
 *
 * The steps are the tools' exported constants, so this exercises the same
 * ordering the tools use: a result over the cap goes through `reply` with the
 * steps the tool would pass, and the test checks which parts were cut and
 * which were left alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEnv } from "../../src/utils/env.js";
import { SEARCH_STEPS } from "../../src/tools/search.js";
import { SCRAPE_STEPS } from "../../src/tools/scrape.js";
import { EXTRACT_STEPS, EXTRACT_DEGRADED_STEPS } from "../../src/tools/extract.js";
import { MAP_STEPS } from "../../src/tools/map.js";
import { BATCH_SCRAPE_STEPS } from "../../src/tools/batch-scrape.js";
import { CRAWL_STEPS } from "../../src/tools/crawl.js";
import { SEARCH_AND_SCRAPE_STEPS } from "../../src/tools/search-and-scrape.js";
import { reply } from "../../src/tools/shared.js";
import { TRUNCATION_ADVICE, type Cut, type TrimStep } from "../../src/utils/fit.js";

validateEnv({
  SEARXNG_URL: "http://searxng.test",
  CRAWL4AI_URL: "http://crawl4ai.test",
  CRAWL4AI_API_TOKEN: "c".repeat(16),
  MCP_AUTH_TOKEN: "t".repeat(32),
  MCP_ALLOWED_HOSTS: "localhost",
  RETRY_MAX_ATTEMPTS: "1",
});

type Obj = Record<string, unknown>;

/** Pass an oversized result through `reply` and return what the client would see. */
function run(structured: Obj, steps: readonly TrimStep[]): { value: Obj; cuts: Cut[] } {
  const r = reply(structured, steps);
  const text = (r.content[0] as { text: string }).text;
  assert.ok(text.length <= 25_000, `text is ${text.length} long, over 25000`);
  assert.equal(text, JSON.stringify(r.structuredContent));
  const value = r.structuredContent as Obj;
  assert.equal(value["truncated"], true);
  assert.equal(r.isError, undefined);
  const truncation = value["truncation"] as { cuts: Cut[] };
  return { value, cuts: truncation.cuts };
}

function doc(i: number, markdown: string | null, internal = 0, external = 0): Obj {
  return {
    url: "https://site.test/" + i,
    finalUrl: null,
    status: markdown === null ? "failed" : "ok",
    markdown,
    title: null,
    links: {
      internal: Array.from({ length: internal }, (_, j) => ({ href: "https://site.test/p/" + j, text: "" })),
      external: Array.from({ length: external }, (_, j) => ({ href: "https://other.test/p/" + j, text: "" })),
    },
    failure: null,
  };
}

function searchResult(n: number): Obj {
  return {
    query: "q",
    results: Array.from({ length: n }, (_, i) => ({
      title: "title " + i,
      url: "https://site.test/" + i,
      snippet: "s".repeat(1_000),
      engines: ["e"],
      score: null,
    })),
    answers: [],
    suggestions: [],
    unresponsiveEngines: [],
    coverage: { requested: n, returned: n, pagesFetched: 1, satisfied: true, shortfall: null },
  };
}

function threeDocs(): Obj[] {
  return [doc(0, "a".repeat(1_000), 2, 1), doc(1, "b".repeat(40_000)), doc(2, "c".repeat(40_000))];
}

const DOCUMENT_CUT_PATHS = [
  "/documents/*/links/internal",
  "/documents/*/links/external",
  "/documents/1/markdown",
  "/documents/2/markdown",
];

test("SEARCH_STEPS drops trailing results and leaves coverage untouched", () => {
  const input = searchResult(50);
  const { value, cuts } = run(input, SEARCH_STEPS);
  const results = value["results"] as unknown[];
  assert.deepEqual(cuts, [{ path: "/results", unit: "items", original: 50, kept: results.length }]);
  assert.ok(results.length > 0 && results.length < 50);
  assert.deepEqual(value["coverage"], input["coverage"]);
});

test("SCRAPE_STEPS cuts the markdown and keeps the document status", () => {
  const { value, cuts } = run({ ...doc(0, "x".repeat(60_000)), links: null }, SCRAPE_STEPS);
  assert.deepEqual(cuts.map((c) => c.path), ["/markdown"]);
  assert.equal(value["status"], "ok");
});

test("EXTRACT_STEPS drops trailing items of an array result", () => {
  const data = Array.from({ length: 100 }, (_, i) => ({ v: String(i).padEnd(500, "v") }));
  const { value, cuts } = run({ url: "u", data, degraded: false, markdown: null, failure: null }, EXTRACT_STEPS);
  assert.deepEqual(cuts, [
    { path: "/data", unit: "items", original: 100, kept: (value["data"] as unknown[]).length },
  ]);
});

test("EXTRACT_STEPS drops a string result whole instead of cutting it mid-way", () => {
  const { value, cuts } = run(
    { url: "u", data: "d".repeat(60_000), degraded: false, markdown: null, failure: null },
    EXTRACT_STEPS,
  );
  assert.deepEqual(cuts, [{ path: "/data", unit: "chars", original: 60000, kept: 0 }]);
  assert.equal(value["data"], null);
});

test("EXTRACT_DEGRADED_STEPS cuts the fallback markdown", () => {
  const { value, cuts } = run(
    { url: "u", data: null, degraded: true, markdown: "x".repeat(60_000), failure: null },
    EXTRACT_DEGRADED_STEPS,
  );
  assert.deepEqual(cuts.map((c) => c.path), ["/markdown"]);
  assert.equal(value["degraded"], true);
});

test("MAP_STEPS drops the external links before trimming the internal ones", () => {
  const { value, cuts } = run(
    {
      url: "u",
      internal: Array.from({ length: 2000 }, (_, i) => "https://site.test/page/" + i),
      external: Array.from({ length: 2000 }, (_, i) => "https://other.test/page/" + i),
      limitReached: false,
    },
    MAP_STEPS,
  );
  assert.deepEqual(cuts.map((c) => c.path), ["/external", "/internal"]);
  assert.equal(cuts[0]?.kept, 0);
  assert.equal(cuts[1]?.kept, (value["internal"] as unknown[]).length);
  assert.ok(cuts[1] !== undefined && cuts[1].kept > 0 && cuts[1].kept < 2000);
  assert.equal(value["limitReached"], false);
});

test("BATCH_SCRAPE_STEPS drops links first, then shares the cut among the long bodies", () => {
  const { value, cuts } = run({ documents: threeDocs(), okCount: 3, failedCount: 0 }, BATCH_SCRAPE_STEPS);
  assert.deepEqual(cuts.map((c) => c.path), DOCUMENT_CUT_PATHS);
  assert.deepEqual(cuts[0], { path: "/documents/*/links/internal", unit: "items", original: 2, kept: 0 });
  assert.deepEqual(cuts[1], { path: "/documents/*/links/external", unit: "items", original: 1, kept: 0 });
  const documents = value["documents"] as Obj[];
  assert.equal(documents[0]?.["markdown"], "a".repeat(1000));
  assert.deepEqual(documents[0]?.["links"], { internal: [], external: [] });
  assert.ok(Math.abs((cuts[2]?.kept ?? 0) - (cuts[3]?.kept ?? 0)) <= 1);
  assert.equal(value["okCount"], 3);
  assert.equal(value["failedCount"], 0);
});

test("CRAWL_STEPS trims the documents and keeps the crawl summary", () => {
  const { value, cuts } = run(
    {
      start: "https://site.test/0",
      state: "completed",
      pagesFetched: 3,
      depthReached: 1,
      stoppedAt: "exhausted",
      documents: threeDocs(),
    },
    CRAWL_STEPS,
  );
  assert.deepEqual(cuts.map((c) => c.path), DOCUMENT_CUT_PATHS);
  assert.equal(value["pagesFetched"], 3);
});

test("SEARCH_AND_SCRAPE_STEPS trims the documents and keeps the search results", () => {
  const { value, cuts } = run({ search: searchResult(3), documents: threeDocs() }, SEARCH_AND_SCRAPE_STEPS);
  assert.deepEqual(cuts.map((c) => c.path), DOCUMENT_CUT_PATHS);
  assert.equal(((value["search"] as Obj)["results"] as unknown[]).length, 3);
});

test("a caller's maxChars is the cap the text is fitted to", () => {
  const structured = { url: "https://site.test/0", markdown: "a".repeat(40_000) };
  const r = reply(structured, SCRAPE_STEPS, 30_000);
  const text = (r.content[0] as { text: string }).text;
  assert.ok(text.length <= 30_000, `text is ${text.length} long, over 30000`);
  assert.ok(text.length > 25_000, `text is ${text.length} long, not past 25000`);
  assert.equal(text, JSON.stringify(r.structuredContent));
  const value = r.structuredContent as Obj;
  assert.equal(value["truncated"], true);
  const truncation = value["truncation"] as { limit: number; advice: string };
  assert.equal(truncation.limit, 30_000);
  assert.equal(truncation.advice, TRUNCATION_ADVICE);
});

test("without maxChars the cap stays at 25000", () => {
  const structured = { url: "https://site.test/0", markdown: "a".repeat(40_000) };
  const r = reply(structured, SCRAPE_STEPS);
  const text = (r.content[0] as { text: string }).text;
  const truncation = (r.structuredContent as Obj)["truncation"] as { limit: number };
  assert.equal(truncation.limit, 25_000);
  assert.ok(text.length <= 25_000, `text is ${text.length} long, over 25000`);
});

test("the advice names maxChars and its maximum", () => {
  assert.ok(TRUNCATION_ADVICE.endsWith("or raise maxChars (at most 500000)."));
});
