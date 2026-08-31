import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { SEARCH_MAX_PAGES } from "../../src/constants.js";
import { search, type SearchOptions } from "../../src/upstream/searxng.js";
import { validateEnv } from "../../src/utils/env.js";
import { UpstreamError } from "../../src/utils/errors.js";

/**
 * When a search stops, and what it admits to when it does.
 *
 * The five stopping conditions in
 * specs/003-search-controls-retry-stdio/contracts/search-tools.md are the
 * subject here, one test each, because the difference between them is the whole
 * value of `coverage`: a caller that only learns "fewer than you asked for"
 * cannot tell a query worth rephrasing from one worth asking again.
 *
 * Every page is served from a stub. Paging is a decision this client makes
 * about a sequence of responses, so a real instance would only add the one
 * variable - what the web happens to hold today - that would make these
 * assertions unreliable.
 */

validateEnv({
  SEARXNG_URL: "http://searxng.test",
  CRAWL4AI_URL: "http://crawl4ai.test",
  CRAWL4AI_API_TOKEN: "c".repeat(16),
  MCP_AUTH_TOKEN: "t".repeat(32),
  MCP_ALLOWED_HOSTS: "localhost",
  // Retrying is off so that a page scripted to fail costs a test no backoff
  // waits. What a failed page does to paging is the subject; whether it is
  // tried twice first belongs to retry.test.ts.
  RETRY_MAX_ATTEMPTS: "1",
});

/** One scripted page: the URLs it returns, or a refusal from the instance. */
type Page = readonly string[] | "fail";

interface Served {
  /** The `pageno` each request carried, in order; null when it carried none. */
  readonly pagenos: (number | null)[];
}

/**
 * Answer `search()` with a scripted sequence of pages.
 *
 * `advanceMs` moves a fake clock on every request, which is the only practical
 * way to reach a 45-second budget in a unit test. It is installed over
 * `performance.now` - the clock the search itself reads - rather than over
 * timers, so nothing here waits.
 */
function serve(
  t: TestContext,
  pages: readonly Page[],
  options: { readonly advanceMs?: number } = {},
): Served {
  const originalFetch = globalThis.fetch;
  const pagenos: (number | null)[] = [];
  let clock = 0;

  if (options.advanceMs !== undefined) {
    const originalNow = performance.now;
    performance.now = () => clock;
    t.after(() => {
      performance.now = originalNow;
    });
  }

  globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const raw = url.searchParams.get("pageno");
    pagenos.push(raw === null ? null : Number(raw));
    clock += options.advanceMs ?? 0;

    // A script that runs out means "nothing more up here", which is what an
    // instance past its last page answers with.
    const page = pages[pagenos.length - 1] ?? [];
    if (page === "fail") {
      return Promise.resolve(new Response("the instance is unwell", { status: 503 }));
    }

    return Promise.resolve(
      new Response(
        JSON.stringify({
          query: "example",
          results: page.map((url) => ({ title: url, url, content: "", engine: "test" })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  return { pagenos };
}

/** `count` distinct URLs, unique to `prefix` so pages do not overlap by accident. */
function urls(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `https://${prefix}.test/${i}`);
}

function options(limit: number): SearchOptions {
  return { query: "example", limit, language: "ja", categories: ["general"] };
}

test("stop 1: the requested count is reached, and nothing is missing", async (t) => {
  const served = serve(t, [urls("one", 8), urls("two", 8)]);

  const result = await search(options(12));

  assert.equal(result.coverage.satisfied, true);
  assert.equal(result.coverage.shortfall, null);
  assert.equal(result.coverage.requested, 12);
  assert.equal(result.coverage.returned, 12, "a satisfied search returns exactly what was asked for");
  assert.equal(result.coverage.pagesFetched, 2);
  assert.equal(result.results.length, 12);

  // The first page carries no `pageno` and the second one does. SearXNG reads
  // an absent `pageno` as the first page, so `pageno=1` would ask for the same
  // page while changing the query string - see search-params.test.ts, which
  // holds the default request to the byte.
  assert.deepEqual(served.pagenos, [null, 2]);
});

test("stop 1: a first page larger than the request needs no second one", async (t) => {
  const served = serve(t, [urls("one", 30)]);

  const result = await search(options(10));

  assert.equal(result.coverage.satisfied, true);
  assert.equal(result.coverage.pagesFetched, 1, "the ordinary search must still cost one request");
  assert.equal(result.results.length, 10, "the extra hits are surplus, not a reason to return more");
  assert.deepEqual(served.pagenos, [null]);
});

test("stop 2: a page that adds nothing new ends the search as exhausted", async (t) => {
  // The second page repeats the first, which is how an instance behaves once it
  // has run out: asking again would only add load.
  const repeated = urls("one", 3);
  const served = serve(t, [repeated, repeated, urls("three", 5)]);

  const result = await search(options(20));

  assert.equal(result.coverage.satisfied, false);
  assert.equal(result.coverage.shortfall, "exhausted");
  assert.equal(result.coverage.returned, 3);
  assert.equal(result.coverage.pagesFetched, 2);
  assert.deepEqual(served.pagenos, [null, 2], "the third page must never be asked for");
});

test("stop 3: the page limit is reported as such, not as an empty web", async (t) => {
  // Every page is fresh and small, so only the page ceiling can stop this.
  const pages = Array.from({ length: SEARCH_MAX_PAGES + 3 }, (_, i) => urls(`p${i}`, 2));
  const served = serve(t, pages);

  const result = await search(options(100));

  assert.equal(result.coverage.satisfied, false);
  assert.equal(result.coverage.shortfall, "page_limit");
  assert.equal(result.coverage.pagesFetched, SEARCH_MAX_PAGES);
  assert.equal(result.coverage.returned, SEARCH_MAX_PAGES * 2);
  assert.equal(served.pagenos.length, SEARCH_MAX_PAGES);
});

test("stop 4: the time budget stops a search that pages are still feeding", async (t) => {
  // 20s per request against a 45s budget: two pages fit, the third takes it
  // past the line. Page count cannot be what stops this - only three of the
  // five allowed pages are fetched.
  const pages = Array.from({ length: SEARCH_MAX_PAGES }, (_, i) => urls(`p${i}`, 2));
  serve(t, pages, { advanceMs: 20_000 });

  const result = await search(options(100));

  assert.equal(result.coverage.satisfied, false);
  assert.equal(result.coverage.shortfall, "time_budget");
  assert.equal(result.coverage.pagesFetched, 3);
  assert.equal(result.coverage.returned, 6, "the pages that did arrive are still returned");
});

test("stop 5: a later page failing returns what was already gathered", async (t) => {
  const served = serve(t, [urls("one", 4), "fail", urls("three", 4)]);

  const result = await search(options(50));

  assert.equal(result.coverage.satisfied, false);
  assert.equal(result.coverage.shortfall, "upstream_failed");
  assert.equal(result.coverage.returned, 4, "an outage on page two must not discard page one");
  assert.equal(
    result.coverage.pagesFetched,
    1,
    "a page that failed was not fetched, whatever the request count says",
  );
  assert.deepEqual(served.pagenos, [null, 2], "the search stops at the failure rather than pressing on");
});

test("a first page that fails is a failed search, not a short one", async (t) => {
  // The asymmetry is deliberate: with nothing gathered there is no partial
  // answer to hand back, and reporting an outage as a thin result set would
  // have an agent rephrasing a query that was never asked.
  const served = serve(t, ["fail", urls("two", 5)]);

  await assert.rejects(
    () => search(options(10)),
    (error: unknown) => {
      assert.ok(error instanceof UpstreamError, `expected an UpstreamError, got ${String(error)}`);
      return true;
    },
  );

  assert.deepEqual(served.pagenos, [null], "a search that cannot start must not page on");
});

test("an unsatisfied search always says why", async (t) => {
  // The invariant behind FR-010, over every path that can end a search. A
  // `satisfied: false` with no reason is the silent shortfall this feature
  // exists to remove, and it would be easy to reintroduce with a new branch.
  const scenarios: { name: string; pages: Page[]; limit: number; advanceMs?: number }[] = [
    { name: "satisfied on the first page", pages: [urls("a", 20)], limit: 10 },
    { name: "satisfied after paging", pages: [urls("a", 6), urls("b", 6)], limit: 10 },
    { name: "nothing at all", pages: [[]], limit: 10 },
    { name: "exhausted", pages: [urls("a", 2), urls("a", 2)], limit: 50 },
    { name: "page limit", pages: Array.from({ length: 8 }, (_, i) => urls(`p${i}`, 1)), limit: 50 },
    { name: "upstream failed", pages: [urls("a", 2), "fail"], limit: 50 },
    {
      name: "time budget",
      pages: Array.from({ length: 5 }, (_, i) => urls(`p${i}`, 1)),
      limit: 50,
      advanceMs: 30_000,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (sub) => {
      serve(
        sub,
        scenario.pages,
        scenario.advanceMs === undefined ? {} : { advanceMs: scenario.advanceMs },
      );
      const { coverage } = await search(options(scenario.limit));

      assert.equal(
        coverage.satisfied,
        coverage.shortfall === null,
        "satisfied and shortfall must never disagree",
      );
      if (!coverage.satisfied) {
        assert.notEqual(coverage.shortfall, null, "a short search must name a reason");
      }
    });
  }
});

test("a URL seen on two pages is returned once", async (t) => {
  // Matched as written, with no normalisation: deciding that two spellings of a
  // URL are the same page is a judgement about the web, and getting it wrong
  // drops a result the caller would have wanted.
  serve(t, [
    ["https://a.test/1", "https://a.test/2", "https://a.test/3"],
    ["https://a.test/2", "https://a.test/3", "https://a.test/4"],
    ["https://a.test/4", "https://a.test/5"],
    [],
  ]);

  const result = await search(options(50));

  assert.deepEqual(
    result.results.map((hit) => hit.url),
    ["https://a.test/1", "https://a.test/2", "https://a.test/3", "https://a.test/4", "https://a.test/5"],
    "the order pages arrived in is the order the caller sees",
  );
  assert.equal(result.coverage.returned, 5, "the count is of distinct URLs, not of rows received");
  assert.equal(new Set(result.results.map((hit) => hit.url)).size, result.results.length);
});

test("a trailing slash is a different URL, because deciding otherwise is not ours to do", async (t) => {
  serve(t, [["https://a.test/x", "https://a.test/x/"], []]);

  const result = await search(options(50));

  assert.equal(result.coverage.returned, 2);
});
