import { test } from "node:test";
import assert from "node:assert/strict";
import { clientFromEnv } from "../client.js";
import { SEARCH_MAX_PAGES } from "../../../src/constants.js";

/**
 * What paging costs, against the real instance.
 *
 * The unit tests decide when the loop stops, because they can hand the loop any
 * upstream they like. This file can only see what the deployment in front of it
 * actually returns, and that is the constraint which shapes every assertion
 * here.
 *
 * Tier A gates merges, so nothing in it may depend on what the public web
 * answered today. That is not a theoretical concern: on the machine this was
 * first run, every engine came back `CAPTCHA` or `Suspended: too many
 * requests`, and SearXNG returned zero results for a query as ordinary as
 * "wikipedia". A datacenter address being turned away says nothing about
 * whether this code is correct - which is exactly why Tier B exists and is not
 * gating.
 *
 * So what is asserted here is only what holds when the web returns everything,
 * nothing, or anything in between: that `coverage` is present at all, that it
 * is internally consistent, and that a search which *was* satisfied at the
 * default limit did not pay for a second page.
 */

const client = clientFromEnv();

interface Coverage {
  readonly requested: number;
  readonly returned: number;
  readonly pagesFetched: number;
  readonly satisfied: boolean;
  readonly shortfall: string | null;
}

const REASONS = ["exhausted", "page_limit", "time_budget", "upstream_failed"];

async function coverageOf(args: Record<string, unknown>): Promise<Coverage> {
  const { structured } = await client.call("web_search", { format: "json", ...args });
  const coverage = structured.coverage as Coverage | undefined;
  assert.ok(coverage, `web_search returned no coverage: ${JSON.stringify(structured)}`);
  return coverage;
}

/** The invariants that must hold for every search, whatever the web did. */
function assertConsistent(c: Coverage, requested: number): void {
  assert.equal(c.requested, requested, "coverage must echo what was asked for");
  assert.equal(
    c.satisfied,
    c.shortfall === null,
    `satisfied and shortfall disagree: ${JSON.stringify(c)}`,
  );
  if (!c.satisfied) {
    // The whole point of the feature: a short list must never arrive without a
    // reason attached, because the caller cannot otherwise tell "the web has no
    // more of this" from "this server stopped looking".
    assert.ok(REASONS.includes(String(c.shortfall)), `unknown shortfall: ${String(c.shortfall)}`);
  }
  assert.ok(c.returned <= c.requested, "more results than were asked for");
  assert.ok(c.pagesFetched >= 1, "a search that answered must have fetched a page");
  assert.ok(
    c.pagesFetched <= SEARCH_MAX_PAGES,
    `fetched ${c.pagesFetched} pages, past the ceiling of ${SEARCH_MAX_PAGES}`,
  );
}

test("coverage is present and consistent for an ordinary search", async () => {
  // Absence would be ambiguous - "all fine" and "this server is too old to say"
  // would look identical to a caller.
  assertConsistent(await coverageOf({ query: "wikipedia" }), 10);
});

test("a default search that was satisfied did not pay for a second page", async () => {
  // This is the guarantee that paging did not make every search in the fleet
  // several times more expensive. It is stated conditionally on purpose: when
  // the engines are blocked there is nothing to satisfy the limit with, and a
  // gating test must not fail for that reason. When they do answer, one page
  // has to be enough for the default limit of 10.
  const coverage = await coverageOf({ query: "wikipedia" });
  assertConsistent(coverage, 10);

  if (coverage.satisfied) {
    assert.equal(
      coverage.pagesFetched,
      1,
      `a satisfied search at the default limit fetched ${coverage.pagesFetched} pages`,
    );
  }
});

test("a shortfall names its reason rather than returning a short list in silence", async () => {
  // 50 is the schema's ceiling for `limit`; asking for more is rejected before
  // a search happens, which would test the schema rather than the loop. A
  // quoted phrase this specific will not produce 50 hits on any instance, so
  // the search is unsatisfied whether the engines answer or not.
  const coverage = await coverageOf({
    query: '"searxng crawl4ai mcp contract test"',
    limit: 50,
  });

  assertConsistent(coverage, 50);
  assert.equal(coverage.satisfied, false, "50 results for a quoted phrase would be a surprise");
  assert.notEqual(coverage.shortfall, null, "an unsatisfied search must say why");
});
