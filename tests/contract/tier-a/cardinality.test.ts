import { test } from "node:test";
import assert from "node:assert/strict";
import { clientFromEnv, FIXTURE } from "../client.js";
import { fetchMetrics, mcpSeries } from "../metrics-client.js";

/**
 * Cardinality.
 *
 * An unbounded label does not merely make this server's metrics noisy - it
 * grows the time-series database that every other service on the host shares.
 * So this is not a tidiness test; it is the one that stops this feature from
 * damaging things it does not own.
 */

const client = clientFromEnv();

let available = true;
try {
  await fetchMetrics();
} catch {
  available = false;
}
const skip = available ? false : "metrics endpoint not reachable (metrics are off)";

async function callTwice(round: string, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await client.call("web_scrape", { url: `${FIXTURE}/index.html?${round}=${i}` });
    await client.call("web_search", { query: `cardinality ${round} ${i}`, limit: 3 });
  }
}

/**
 * The one label whose values an upstream chooses.
 *
 * Every other label in this server is drawn from a set decided in the source -
 * tool names, failure kinds, upstream names, operations - so their spaces are
 * saturated within a handful of calls. `engine` and its `reason` come from the
 * metasearch instance, and how fast that space fills depends entirely on what
 * the engines are doing today: on a machine whose address every engine turns
 * away, a single engine walks through `captcha`, `suspended`, `timeout`,
 * `error` and `other` across a run, discovering a new pair each time.
 *
 * That is bounded growth, not unbounded growth, and mixing it into a single
 * count made the difference impossible to see. So it is measured on its own,
 * against the ceiling its own label sets imply.
 */
const ENGINE_METRIC = "mcp_search_engine_unresponsive_total";

/**
 * The most series each metric can ever have, from its declared label sets.
 *
 * This is the assertion that actually catches an unbounded label: a value an
 * upstream chose the wording of would sail past these numbers, and it does so
 * without depending on the order in which a bounded space happens to fill.
 *
 * Histograms count one series per bucket, plus +Inf, plus _sum and _count.
 */
const CEILING: Record<string, number> = {
  // BoundedLabelSet caps engines at 40 and folds the rest into "other"; five
  // reasons. See src/metrics/normalize.ts.
  [ENGINE_METRIC]: 41 * 5,
  mcp_tool_calls_total: 8 * 2, // eight tools x {success, failure}
  mcp_tool_failures_total: 8 * 10, // eight tools x ten FailureKind values
  mcp_tool_duration_seconds: 8 * (9 + 1 + 2), // nine buckets + Inf + sum + count
  mcp_search_results_total: 2,
  mcp_documents_total: 2,
  mcp_upstream_requests_total: 2 * 2,
  mcp_upstream_duration_seconds: 2 * 6 * (10 + 1 + 2), // upstream x operation
  mcp_upstream_retries_total: 2 * 4,
  mcp_search_shortfall_total: 4,
  mcp_fetch_slots_in_use: 1,
  mcp_fetch_slots_limit: 1,
  mcp_concurrency_rejected_total: 1,
};

/** Strip labels and the histogram suffix, leaving the metric a series belongs to. */
function metricOf(line: string): string {
  const name = line.includes("{") ? line.slice(0, line.indexOf("{")) : line;
  return name.replace(/_(bucket|sum|count)$/, "");
}

function countByMetric(series: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of series) {
    const metric = metricOf(line);
    counts.set(metric, (counts.get(metric) ?? 0) + 1);
  }
  return counts;
}

test("no metric can grow past the ceiling its own labels imply", { skip }, async () => {
  await callTwice("ceiling", 10);

  for (const [metric, count] of countByMetric(mcpSeries(await fetchMetrics()))) {
    const ceiling = CEILING[metric];
    assert.ok(
      ceiling !== undefined,
      `${metric} has no declared ceiling; a new metric must state the size of its label space here`,
    );
    assert.ok(
      count <= ceiling,
      `${metric} has ${count} series, past the ${ceiling} its labels allow; a label is carrying a value we did not choose`,
    );
  }
});

test("series do not track the number of requests", { skip }, async () => {
  // Fifteen calls, every one with a different URL and a different query. A
  // label carrying a per-request value would add roughly fifteen series; the
  // engine metric is excluded because its growth is bounded but paced by the
  // engines rather than by us, and is covered by the ceiling test above.
  const others = async (): Promise<number> =>
    mcpSeries(await fetchMetrics()).filter((l) => !l.startsWith(ENGINE_METRIC)).length;

  await callTwice("warmup", 10);
  const afterWarmup = await others();

  await callTwice("first", 15);
  const afterFirst = await others();

  await callTwice("second", 15);
  const afterSecond = await others();

  assert.ok(
    afterSecond - afterFirst <= 2,
    `series grew by ${afterSecond - afterFirst} over 15 fresh calls ` +
      `(${afterWarmup} -> ${afterFirst} -> ${afterSecond}); a label is carrying a per-request value`,
  );
});

test("the engine label fills, but does not race the request count", { skip }, async () => {
  // The engine space is allowed to keep filling - that is what a bounded space
  // does - but it must fill *slower* than requests arrive. Discovering a new
  // (engine, reason) pair on most calls would mean one of the two is not
  // actually bounded.
  const engineSeries = async (): Promise<number> =>
    mcpSeries(await fetchMetrics()).filter((l) => l.startsWith(ENGINE_METRIC)).length;

  const before = await engineSeries();
  await callTwice("engines", 15);
  const after = await engineSeries();

  assert.ok(
    after - before < 15 / 3,
    `the engine label gained ${after - before} series over 15 calls (${before} -> ${after}); ` +
      "it is tracking requests rather than filling a fixed space",
  );
  assert.ok(after <= CEILING[ENGINE_METRIC]!, "the engine label passed its ceiling");
});

test("the labels added by 003 can only take values we enumerated", { skip }, async () => {
  // Both counters are absent until the thing they count happens - a retry, or a
  // search that came up short - and a healthy stack may produce neither during
  // a run. So this asserts a property of whatever is there, not that anything
  // is: it is the *values* that must come from a set decided in advance, which
  // is the whole of the cardinality discipline.
  const allowed: Record<string, ReadonlySet<string>> = {
    "mcp_upstream_retries_total|upstream": new Set(["searxng", "crawl4ai"]),
    "mcp_upstream_retries_total|reason": new Set([
      "connect",
      "http_5xx",
      "rate_limited",
      "timeout",
    ]),
    "mcp_search_shortfall_total|reason": new Set([
      "exhausted",
      "page_limit",
      "time_budget",
      "upstream_failed",
    ]),
  };

  for (const line of mcpSeries(await fetchMetrics())) {
    const name = line.slice(0, line.indexOf("{") === -1 ? undefined : line.indexOf("{"));
    if (!name.startsWith("mcp_upstream_retries_total") && !name.startsWith("mcp_search_shortfall_total")) {
      continue;
    }
    for (const [, label, value] of line.matchAll(/(\w+)="([^"]*)"/g)) {
      const permitted = allowed[`${name}|${label!}`];
      assert.ok(permitted, `${name} carries an unexpected label "${label!}"`);
      assert.ok(
        permitted.has(value!),
        `${name}{${label!}="${value!}"} is outside the enumerated set; ` +
          `an upstream is choosing this label's wording`,
      );
    }
  }
});
