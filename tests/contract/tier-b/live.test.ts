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
