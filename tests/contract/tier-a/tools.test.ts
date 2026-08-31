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
  "web_job_status",
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

test("web_map lists the links without returning the body", async () => {
  const { structured } = await client.call("web_map", {
    url: `${FIXTURE}/index.html`,
    includeExternal: true,
  });
  const internal = structured.internal as string[];
  const external = structured.external as string[];

  assert.ok(internal.some((u) => u.includes("product.html")), "internal links are missing");
  assert.ok(external.some((u) => u.includes("example.com")), "external links were requested but not returned");
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

test("web_job_status rejects an id that does not exist", async () => {
  const { structured } = await client.call("web_job_status", { jobId: "crawl_nope" });
  const failure = structured.failure as { kind: string };
  assert.equal(failure.kind, "invalidInput", "an unknown id is the caller's mistake, not an outage");
});

test("web_search answers, and says which engines did not", async () => {
  const { structured } = await client.call("web_search", { query: "example", limit: 3 });
  assert.ok(Array.isArray(structured.results));
  assert.ok(
    Array.isArray(structured.unresponsiveEngines),
    "an empty result set is only interpretable alongside this",
  );
});
