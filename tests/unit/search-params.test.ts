import { test } from "node:test";
import assert from "node:assert/strict";
import { SearchInput, SearchAndScrapeInput } from "../../src/schemas/tools.js";
import { search, type SearchOptions } from "../../src/upstream/searxng.js";
import { validateEnv } from "../../src/utils/env.js";

/**
 * The search narrowing arguments, from both ends.
 *
 * One end is what a caller is allowed to say: a value the upstream does not
 * understand has to be refused here, where the caller learns which values do
 * work, rather than upstream, where it silently becomes an unfiltered search.
 *
 * The other end is what the upstream is told. The narrowing arguments are all
 * optional, and "optional" has to mean *absent from the request*, not "sent
 * with a default we picked". That distinction is invisible in the schema and
 * only observable in the query string, which is why the query string is
 * asserted directly.
 */

validateEnv({
  SEARXNG_URL: "http://searxng.test",
  CRAWL4AI_URL: "http://crawl4ai.test",
  CRAWL4AI_API_TOKEN: "c".repeat(16),
  MCP_AUTH_TOKEN: "t".repeat(32),
  MCP_ALLOWED_HOSTS: "localhost",
});

/**
 * Run a search against a stubbed transport and hand back what was requested.
 *
 * An empty result set is what the stub answers with: it is the one body that
 * ends the call after a single request no matter how the paging rules evolve,
 * so this stays a test about the query string.
 */
async function requestedUrls(options: SearchOptions): Promise<URL[]> {
  const original = globalThis.fetch;
  const seen: URL[] = [];

  globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
    seen.push(new URL(input instanceof Request ? input.url : String(input)));
    return Promise.resolve(
      new Response(JSON.stringify({ query: options.query, results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  try {
    await search(options);
  } finally {
    globalThis.fetch = original;
  }
  return seen;
}

function firstQuery(urls: URL[]): URLSearchParams {
  assert.ok(urls.length > 0, "no request reached the upstream");
  return urls[0]!.searchParams;
}

test("a period the upstream does not offer is refused before anything is requested", () => {
  const parsed = SearchInput.safeParse({ query: "example", timeRange: "hour" });
  assert.equal(parsed.success, false, '"hour" is not one of the periods SearXNG offers');

  const issue = parsed.error?.issues.find((i) => i.path[0] === "timeRange");
  assert.ok(issue, `the refusal must name the offending argument: ${JSON.stringify(parsed.error?.issues)}`);
  // The caller has to learn what *would* work; "invalid input" alone leaves an
  // agent to guess, and guessing at an enum is how a loop starts.
  for (const accepted of ["day", "week", "month", "year"]) {
    assert.match(
      JSON.stringify(issue),
      new RegExp(accepted),
      `the message must list ${accepted} as an accepted value`,
    );
  }
});

test("a safesearch level outside the upstream's three is refused", () => {
  assert.equal(SearchInput.safeParse({ query: "example", safesearch: 3 }).success, false);
  assert.equal(SearchInput.safeParse({ query: "example", safesearch: -1 }).success, false);

  for (const level of [0, 1, 2]) {
    assert.equal(
      SearchInput.safeParse({ query: "example", safesearch: level }).success,
      true,
      `${level} is a level the upstream accepts`,
    );
  }
});

test("an empty engine list is refused rather than read as every engine", () => {
  // `engines: []` and an omitted `engines` would send exactly the same request,
  // so accepting the empty list would let a caller believe it had narrowed the
  // search when it had not.
  const parsed = SearchInput.safeParse({ query: "example", engines: [] });
  assert.equal(parsed.success, false);
  assert.ok(parsed.error?.issues.some((i) => i.path[0] === "engines"));

  assert.equal(SearchInput.safeParse({ query: "example", engines: ["google"] }).success, true);

  // An engine name this server has never heard of is not its business: the
  // list of enabled engines lives in the instance's settings, and validating
  // against a copy here would go stale the first time an operator edits it.
  assert.equal(
    SearchInput.safeParse({ query: "example", engines: ["nosuchengine"] }).success,
    true,
    "engine names are the instance's to judge, not ours",
  );
});

test("web_search_and_scrape refuses the same values web_search does", () => {
  // Being able to narrow a search but not a search-and-read would push a caller
  // to do the composition by hand, which is the one thing this tool exists to
  // spare them.
  assert.equal(SearchAndScrapeInput.safeParse({ query: "example", timeRange: "hour" }).success, false);
  assert.equal(SearchAndScrapeInput.safeParse({ query: "example", safesearch: 3 }).success, false);
  assert.equal(SearchAndScrapeInput.safeParse({ query: "example", engines: [] }).success, false);
  assert.equal(
    SearchAndScrapeInput.safeParse({
      query: "example",
      timeRange: "week",
      safesearch: 1,
      engines: ["google", "duckduckgo"],
    }).success,
    true,
  );
});

test("an omitted narrowing argument stays omitted after parsing", () => {
  // A `.default()` here would be undetectable in the schema and fatal to the
  // promise below: the value would arrive at the upstream on every call.
  for (const schema of [SearchInput, SearchAndScrapeInput]) {
    const parsed = schema.parse({ query: "example" });
    assert.ok(!("timeRange" in parsed), "timeRange must not be materialised");
    assert.ok(!("safesearch" in parsed), "safesearch must not be materialised");
    assert.ok(!("engines" in parsed), "engines must not be materialised");
  }
});

test("omitting all three sends the request this server sent before they existed", async () => {
  const urls = await requestedUrls({
    query: "example search",
    limit: 10,
    language: "ja",
    categories: ["general"],
  });

  const params = firstQuery(urls);
  for (const key of ["time_range", "safesearch", "engines"]) {
    assert.equal(params.has(key), false, `${key} must not be sent when it was not asked for`);
  }

  // Byte-for-byte, not merely "the three are absent" (SC-003). Anything else
  // added to a default search - a page number included - changes what the
  // upstream is asked and puts the claim of an unchanged default at risk.
  assert.equal(urls[0]!.search, "?q=example+search&format=json&language=ja&categories=general");
});

test("each narrowing argument reaches the upstream under its own name", async () => {
  const params = firstQuery(
    await requestedUrls({
      query: "example",
      limit: 10,
      language: "auto",
      categories: ["general"],
      engines: ["google", "duckduckgo"],
      timeRange: "week",
      safesearch: 0,
    }),
  );

  // SearXNG takes the engines as one comma-joined value; repeated `engines`
  // parameters are not the same thing to it.
  assert.equal(params.get("engines"), "google,duckduckgo");
  assert.equal(params.get("time_range"), "week");
  // 0 is a level, not an absence. A truthiness check here would drop it and
  // quietly leave the instance's own default in force.
  assert.equal(params.get("safesearch"), "0");
});

test("naming engines narrows the search instead of widening it", async () => {
  // SearXNG unions `engines` with `categories`, so sending both asks for the
  // named engines *plus* everything in the category. Since `categories`
  // defaults to ["general"], every call was sending it, and the parameter this
  // tool advertises as a way to limit a search never limited anything -
  // measured against a live instance, asking for duckduckgo came back entirely
  // from brave and google cse.
  const withEngines = firstQuery(
    await requestedUrls({
      query: "q",
      limit: 5,
      categories: ["general"],
      engines: ["duckduckgo"],
    }),
  );
  assert.equal(withEngines.get("engines"), "duckduckgo");
  assert.equal(
    withEngines.get("categories"),
    null,
    "categories alongside engines widens the selection back out",
  );

  // And the ordinary call is untouched: no engines named, category still sent.
  const withoutEngines = firstQuery(
    await requestedUrls({ query: "q", limit: 5, categories: ["general"] }),
  );
  assert.equal(withoutEngines.get("engines"), null);
  assert.equal(withoutEngines.get("categories"), "general");
});
