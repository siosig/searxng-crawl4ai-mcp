import { test } from "node:test";
import assert from "node:assert/strict";
import { clientFromEnv } from "../client.js";

/**
 * The public internet.
 *
 * These are reported but do not gate a merge. A datacenter IP being served a
 * CAPTCHA says something about where CI runs, not about whether this code is
 * correct - and letting that stop an upstream update would defeat the point of
 * being able to follow upstream at all.
 */

const client = clientFromEnv();

test("a real search returns real hits", async () => {
  const { structured } = await client.call("web_search", {
    query: "model context protocol specification",
    limit: 5,
  });
  const results = structured.results as unknown[];
  const unresponsive = structured.unresponsiveEngines as { engine: string; reason: string }[];

  if (results.length === 0) {
    assert.fail(
      `no hits. Engines that refused: ${unresponsive.map((e) => `${e.engine} (${e.reason})`).join(", ") || "none"}`,
    );
  }
  assert.ok(results.length > 0);
});

test("narrowing to a period changes which pages come back", async () => {
  // A subject that is written about continuously, so "this week" and "ever"
  // genuinely differ. The assertion is that the filter reached the engines at
  // all - proving the dates are inside the window would mean trusting result
  // metadata that most engines do not return.
  const query = "typescript release notes";
  const unfiltered = await client.call("web_search", { query, limit: 10 });
  const recent = await client.call("web_search", { query, limit: 10, timeRange: "week" });

  const urls = (r: typeof unfiltered): string[] =>
    (r.structured.results as { url: string }[]).map((h) => h.url);

  assert.ok(urls(recent).length > 0, "a week is not too narrow for this subject");
  assert.notDeepEqual(
    urls(recent),
    urls(unfiltered),
    "the same hits in the same order means time_range never reached the engines",
  );
});

test("narrowing to one engine leaves results from only that engine", async () => {
  const engine = "duckduckgo";
  const { structured } = await client.call("web_search", {
    query: "model context protocol",
    limit: 5,
    engines: [engine],
  });

  const results = structured.results as { url: string; engines: string[] }[];
  const unresponsive = structured.unresponsiveEngines as { engine: string; reason: string }[];
  if (results.length === 0) {
    // Being served a CAPTCHA is the usual reason and says nothing about this
    // code, which is why this tier does not gate a merge.
    assert.fail(
      `${engine} returned nothing. Engines that refused: ${unresponsive.map((e) => `${e.engine} (${e.reason})`).join(", ") || "none"}`,
    );
  }

  const sources = new Set(results.flatMap((h) => h.engines));
  assert.deepEqual(
    [...sources],
    [engine],
    "a hit from any other engine means the engines parameter was not honoured",
  );
});

test("a real page can be fetched", async () => {
  const { structured } = await client.call("web_scrape", { url: "https://example.com" });
  assert.equal(structured.status, "ok", JSON.stringify(structured.failure));
  assert.match(String(structured.markdown), /Example Domain/);
});

test("structured extraction works with real credentials", async () => {
  const { structured } = await client.call("web_extract", {
    url: "https://example.com",
    instruction: "the page title",
  });
  if (structured.degraded === true) {
    assert.fail("no model credentials configured in this environment");
  }
  assert.equal(structured.failure, null, JSON.stringify(structured.failure));
  assert.notEqual(structured.data, null);
});
