import { test } from "node:test";
import assert from "node:assert/strict";
import { clientFromEnv, FIXTURE } from "../client.js";

/**
 * Every tool, against the fixture origin.
 *
 * These run the real stack - the MCP server, SearXNG and Crawl4AI containers
 * are all up - but read from a site inside the network, so a result is about
 * this code rather than about today's weather on the public internet.
 */

const client = clientFromEnv();
const TOOLS = [
  "web_search",
  "web_scrape",
  "web_search_and_scrape",
  "web_batch_scrape",
  "web_crawl",
  "web_map",
  "web_extract",
];

test("every tool is advertised", async () => {
  const names = await client.listTools();
  for (const tool of TOOLS) assert.ok(names.includes(tool), `${tool} is missing`);
  assert.equal(names.length, TOOLS.length, `unexpected tools: ${names.filter((n) => !TOOLS.includes(n)).join(", ")}`);
});

test("web_scrape returns the page content", async () => {
  const { structured } = await client.call("web_scrape", { url: `${FIXTURE}/index.html` });
  assert.equal(structured.status, "ok", JSON.stringify(structured.failure));
  assert.match(String(structured.markdown), /Fixture Home/);
});

test("web_batch_scrape reports each URL separately and keeps the order", async () => {
  const urls = [`${FIXTURE}/index.html`, `${FIXTURE}/product.html`, `${FIXTURE}/missing.html`];
  const { structured } = await client.call("web_batch_scrape", { urls });

  const documents = structured.documents as { url: string; status: string }[];
  assert.equal(documents.length, 3);
  assert.deepEqual(documents.map((d) => d.url), urls, "results must stay in the order given");
  assert.equal(structured.okCount, 2);
  assert.equal(structured.failedCount, 1, "a missing page must not fail the whole call");
});

test("web_scrape reports a missing page as the target's 404, not as a backend fault", async () => {
  const { structured, isError } = await client.call("web_scrape", { url: `${FIXTURE}/missing.html` });
  const reason = structured.failure as { kind?: string; upstreamStatus?: number | null; message?: string } | null;

  assert.equal(isError, true, "a single-page read that failed must be announced as a failed call");
  assert.equal(structured.status, "failed");
  assert.equal(reason?.kind, "httpError");
  assert.equal(
    reason?.upstreamStatus,
    404,
    `the scraping backend's own failure leaked through instead: ${reason?.message}`,
  );
});

test("web_scrape returns a page too short for Crawl4AI's structural heuristic", async () => {
  const { structured } = await client.call("web_scrape", { url: `${FIXTURE}/version.txt` });
  assert.equal(structured.status, "ok", JSON.stringify(structured.failure));
  assert.match(String(structured.markdown), /1\.100\.0/);
});

test("web_batch_scrape of nothing but missing pages still reports per URL", async () => {
  const { structured } = await client.call("web_batch_scrape", { urls: [`${FIXTURE}/missing.html`] });
  assert.equal(structured.okCount, 0);
  assert.equal(structured.failedCount, 1, "a batch in which every page fails must not fail as a whole");
});

test("web_map lists the links without returning the body", async () => {
  const { structured } = await client.call("web_map", {
    url: `${FIXTURE}/index.html`,
    includeExternal: true,
  });
  const internal = structured.internal as string[];
  const external = structured.external as string[];

  assert.ok(internal.some((u) => u.includes("product.html")), "internal links are missing");
  assert.ok(external.some((u) => u.includes("example.com")), "external links were requested but not returned");
  assert.equal(structured.limitReached, false);
});

test("web_map says when limit cut the list, apart from the size cap", async () => {
  // The fixture links three internal pages. `truncated` is the response size
  // cap and is set for every tool; the list limit needs a name of its own.
  const { structured } = await client.call("web_map", { url: `${FIXTURE}/index.html`, limit: 1 });
  assert.equal((structured.internal as string[]).length, 1);
  assert.equal(structured.limitReached, true, "a list cut by limit must say so");
  assert.equal(structured.truncated, false, "a short list is not a size-capped response");
});

test("web_crawl follows levels and stops at the page limit", async () => {
  const deep = await client.call("web_crawl", {
    url: `${FIXTURE}/index.html`,
    maxDepth: 2,
    maxPages: 20,
  });
  const pages = deep.structured.pagesFetched as number;
  assert.ok(pages > 1, `expected several pages, fetched ${pages}`);

  const capped = await client.call("web_crawl", {
    url: `${FIXTURE}/index.html`,
    maxDepth: 3,
    maxPages: 2,
  });
  assert.equal(capped.structured.pagesFetched, 2, "the page cap must be honoured");
  assert.equal(capped.structured.stoppedAt, "pages", "hitting a limit must be visible in the result");
  assert.equal(capped.structured.state, "completed", "a capped crawl finished; it did not fail");
});

test("web_crawl stays on the starting host", async () => {
  const { structured } = await client.call("web_crawl", {
    url: `${FIXTURE}/index.html`,
    maxDepth: 2,
    maxPages: 10,
    sameHostOnly: true,
  });
  const documents = structured.documents as { url: string }[];
  const hosts = new Set(documents.map((d) => new URL(d.url).host));
  assert.equal(hosts.size, 1, `crawl wandered to ${[...hosts].join(", ")}`);
});

test("web_search answers, and says which engines did not", async () => {
  const { structured } = await client.call("web_search", { query: "example", limit: 3 });
  assert.ok(Array.isArray(structured.results));
  assert.ok(
    Array.isArray(structured.unresponsiveEngines),
    "an empty result set is only interpretable alongside this",
  );
});

interface Truncation {
  limit: number;
  originalLength: number;
  cuts: { path: string; unit: string; original: number; kept: number }[];
}

const RESPONSE_CAP = 25000;

test("every result's text is its structuredContent, serialised", async () => {
  const index = `${FIXTURE}/index.html`;
  const calls: [string, Record<string, unknown>][] = [
    ["web_scrape", { url: index }],
    ["web_batch_scrape", { urls: [index, `${FIXTURE}/product.html`, `${FIXTURE}/missing.html`] }],
    ["web_map", { url: index, includeExternal: true }],
    ["web_crawl", { url: index, maxDepth: 1, maxPages: 3 }],
    ["web_search", { query: "example", limit: 3 }],
    ["web_extract", { url: "http://169.254.169.254/latest/meta-data/", instruction: "the title" }],
  ];

  for (const [name, args] of calls) {
    const { text, structured, isError } = await client.call(name, args);
    assert.deepEqual(JSON.parse(text), structured, `${name}: text is not its structuredContent`);
    assert.equal(structured.truncated, false, `${name}: a small result must not be cut`);
    assert.equal(structured.truncation, null, `${name}: no cut, so no truncation record`);
    if (name === "web_extract") {
      // The destination policy refuses a link-local address before any fetch.
      const failure = structured.failure as { kind?: string } | null;
      assert.equal(isError, true, "a refused extraction must be announced as a failed call");
      assert.equal(failure?.kind, "egressDenied");
    }
  }
});

test("format is refused before the tool runs", async () => {
  const calls: [string, Record<string, unknown>][] = [
    ["web_scrape", { url: `${FIXTURE}/index.html`, format: "json" }],
    ["web_search", { query: "example", format: "markdown" }],
  ];

  for (const [name, args] of calls) {
    const { text, structured, isError } = await client.call(name, args);
    assert.equal(isError, true, `${name}: an unknown argument must fail the call`);
    assert.ok(text.startsWith("Input validation error:"), `${name}: unexpected text: ${text.slice(0, 120)}`);
    assert.equal(Object.keys(structured).length, 0, `${name}: nothing may be structured before the tool runs`);
  }
});

test("a page over the cap comes back reduced, as valid JSON", async () => {
  const { text, structured } = await client.call("web_scrape", { url: `${FIXTURE}/large.html` });
  assert.equal(structured.status, "ok", JSON.stringify(structured.failure));
  assert.ok(text.length <= RESPONSE_CAP, `text is ${text.length} chars`);
  assert.deepEqual(JSON.parse(text), structured);

  const truncation = structured.truncation as Truncation;
  assert.equal(structured.truncated, true);
  assert.equal(truncation.limit, RESPONSE_CAP);
  assert.ok(truncation.originalLength > RESPONSE_CAP);
  assert.equal(truncation.cuts.length, 1);

  const cut = truncation.cuts[0];
  assert.ok(cut, "the cut is missing");
  assert.equal(cut.path, "/markdown");
  assert.equal(cut.unit, "chars");
  assert.ok(cut.kept < cut.original);
  assert.equal(cut.kept, (structured.markdown as string).length);
});

test("a batch over the cap keeps every document and cuts the long body only", async () => {
  const { text, structured } = await client.call("web_batch_scrape", {
    urls: [`${FIXTURE}/index.html`, `${FIXTURE}/large.html`],
  });
  const documents = structured.documents as { markdown: string; links: unknown }[];
  const truncation = structured.truncation as Truncation;

  assert.equal(structured.okCount, 2);
  assert.equal(structured.failedCount, 0);
  assert.equal(documents.length, 2);
  assert.ok(text.length <= RESPONSE_CAP, `text is ${text.length} chars`);
  assert.deepEqual(truncation.cuts.map((c) => c.path), [
    "/documents/*/links/internal",
    "/documents/*/links/external",
    "/documents/1/markdown",
  ]);
  assert.deepEqual(documents[0]?.links, { internal: [], external: [] });
  assert.equal(documents[1]?.markdown.length, truncation.cuts[2]?.kept);
  assert.ok(
    !truncation.cuts.some((c) => c.path === "/documents/0/markdown"),
    "the short document must not be cut",
  );
});
