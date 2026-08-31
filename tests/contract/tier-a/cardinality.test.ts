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

test("series stop appearing once the finite label space is covered", { skip }, async () => {
  // The property that matters is not "the count never moves" - a bounded label
  // space fills in as values are observed for the first time, and search
  // engines legitimately move between reasons over a run. What matters is that
  // the count *stops*: growth must not track the number of requests.
  await callTwice("warmup", 10);
  const afterWarmup = mcpSeries(await fetchMetrics()).length;

  await callTwice("first", 15);
  const afterFirst = mcpSeries(await fetchMetrics()).length;

  await callTwice("second", 15);
  const afterSecond = mcpSeries(await fetchMetrics()).length;

  // 15 more calls, every one with a different URL and query. If any label
  // carried a per-request value this would grow by roughly 15 each round.
  assert.ok(
    afterSecond - afterFirst <= 2,
    `series grew by ${afterSecond - afterFirst} over 15 fresh calls ` +
      `(${afterWarmup} -> ${afterFirst} -> ${afterSecond}); a label is carrying a per-request value`,
  );

  // And growth must be decelerating, not linear.
  assert.ok(
    afterSecond - afterFirst <= afterFirst - afterWarmup + 1,
    "series growth is not slowing down as the label space fills",
  );
});

test("the total number of series stays small enough to reason about", { skip }, async () => {
  const series = mcpSeries(await fetchMetrics());
  assert.ok(
    series.length < 400,
    `${series.length} series is more than this design accounts for; check for an unbounded label`,
  );
});
