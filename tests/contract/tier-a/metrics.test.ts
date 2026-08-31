import { test } from "node:test";
import assert from "node:assert/strict";
import { clientFromEnv, FIXTURE } from "../client.js";
import { fetchMetrics, sampleValue } from "../metrics-client.js";

/**
 * The metrics endpoint, exercised against the running stack.
 *
 * Skipped when METRICS_URL is not reachable, because the same suite has to
 * pass on a stack started without metrics at all.
 */

const client = clientFromEnv();

async function metricsAvailable(): Promise<boolean> {
  try {
    await fetchMetrics();
    return true;
  } catch {
    return false;
  }
}

const available = await metricsAvailable();
const skip = available ? false : "metrics endpoint not reachable (metrics are off)";

test("the endpoint publishes every metric the contract names", { skip }, async () => {
  const text = await fetchMetrics();
  for (const name of [
    "mcp_tool_calls_total",
    "mcp_tool_failures_total",
    "mcp_tool_duration_seconds",
    "mcp_search_results_total",
    "mcp_search_engine_unresponsive_total",
    "mcp_documents_total",
    "mcp_upstream_requests_total",
    "mcp_upstream_duration_seconds",
    "mcp_fetch_slots_in_use",
    "mcp_fetch_slots_limit",
    "mcp_concurrency_rejected_total",
  ]) {
    assert.ok(text.includes(`# HELP ${name}`), `${name} is missing from /metrics`);
  }
  // Process-level metrics matter on a small host: they answer "is it us?".
  assert.match(text, /process_resident_memory_bytes/);
});

test("a refusal and an unreachable host are counted separately", { skip }, async () => {
  await client.call("web_scrape", { url: "http://10.255.255.1/" });
  await client.call("web_scrape", { url: "http://nothing-resolves-here.invalid/" });

  const text = await fetchMetrics();
  const denied = sampleValue(text, 'mcp_tool_failures_total{tool="web_scrape",kind="egressDenied"}');
  const unreachable = sampleValue(text, 'mcp_tool_failures_total{tool="web_scrape",kind="unreachable"}');

  assert.ok((denied ?? 0) > 0, "a policy refusal was not counted");
  assert.ok((unreachable ?? 0) > 0, "an unreachable host was not counted");
  // If these ever collapse into one label, the dashboard stops being able to
  // tell "we refused this" from "the site is down".
});

test("per-URL outcomes are counted apart from per-call outcomes", { skip }, async () => {
  const before = await fetchMetrics();
  const callsBefore = sampleValue(before, 'mcp_tool_calls_total{tool="web_batch_scrape",result="success"}') ?? 0;
  const okBefore = sampleValue(before, 'mcp_documents_total{result="ok"}') ?? 0;
  const failedBefore = sampleValue(before, 'mcp_documents_total{result="failed"}') ?? 0;

  await client.call("web_batch_scrape", {
    urls: [`${FIXTURE}/index.html`, `${FIXTURE}/product.html`, `${FIXTURE}/missing.html`],
  });

  const after = await fetchMetrics();
  const callsAfter = sampleValue(after, 'mcp_tool_calls_total{tool="web_batch_scrape",result="success"}') ?? 0;
  const okAfter = sampleValue(after, 'mcp_documents_total{result="ok"}') ?? 0;
  const failedAfter = sampleValue(after, 'mcp_documents_total{result="failed"}') ?? 0;

  assert.equal(callsAfter - callsBefore, 1, "the call itself succeeded, so it counts once");
  assert.equal(okAfter - okBefore, 2, "two URLs were fetched");
  assert.equal(failedAfter - failedBefore, 1, "one URL failed without failing the call");
});

test("upstream latency is attributed to the upstream that caused it", { skip }, async () => {
  await client.call("web_scrape", { url: `${FIXTURE}/index.html` });
  await client.call("web_search", { query: "attribution probe", limit: 3 });

  const text = await fetchMetrics();
  assert.ok(
    text.includes('mcp_upstream_duration_seconds_count{upstream="crawl4ai"'),
    "fetch latency is not attributed to the scraping backend",
  );
  assert.ok(
    text.includes('mcp_upstream_duration_seconds_count{upstream="searxng"'),
    "search latency is not attributed to the metasearch backend",
  );
});

test("searches record whether they found anything", { skip }, async () => {
  await client.call("web_search", { query: "outcome probe", limit: 3 });
  const text = await fetchMetrics();
  assert.match(text, /mcp_search_results_total\{outcome="(hits|empty)"\}/);
});
