import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The upstream HTTP contract, checked directly.
 *
 * If these fail, nothing above them can work, and the cause is an upstream
 * change rather than a bug here. Keeping them separate from the tool tests is
 * what turns a version bump from "something broke" into "this specific
 * guarantee was withdrawn".
 */

const SEARXNG = process.env.SEARXNG_PROBE_URL ?? "http://127.0.0.1:8081";
const CRAWL4AI = process.env.CRAWL4AI_PROBE_URL ?? "http://127.0.0.1:11235";
const TOKEN = process.env.CRAWL4AI_API_TOKEN ?? "";

test("SearXNG answers JSON searches rather than refusing them", async () => {
  const res = await fetch(`${SEARXNG}/search?q=contract+test&format=json`);
  assert.notEqual(
    res.status,
    403,
    "403 means `json` is missing from search.formats in settings.yml - there is no environment variable for it",
  );
  assert.equal(res.status, 200);
});

test("the SearXNG response still carries all seven keys", async () => {
  const res = await fetch(`${SEARXNG}/search?q=contract+test&format=json`);
  const body = (await res.json()) as Record<string, unknown>;

  for (const key of [
    "query",
    "results",
    "answers",
    "corrections",
    "infoboxes",
    "suggestions",
    "unresponsive_engines",
  ]) {
    assert.ok(key in body, `SearXNG no longer returns "${key}"`);
  }
  assert.ok(Array.isArray(body.results));
  assert.ok(
    Array.isArray(body.unresponsive_engines),
    "without this, a blocked search cannot be told from an empty one",
  );
});

test("Crawl4AI is reachable over the network, not only on its own loopback", async () => {
  const res = await fetch(`${CRAWL4AI}/health`);
  assert.equal(
    res.status,
    200,
    "a connection reset here usually means CRAWL4AI_API_TOKEN is unset, which makes it bind loopback-only",
  );
});

test("Crawl4AI refuses unauthenticated API calls", async () => {
  const res = await fetch(`${CRAWL4AI}/crawl/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ urls: ["http://fixture-site/index.html"] }),
  });
  assert.equal(res.status, 401);
});

const FIXTURE_PAGE = process.env.FIXTURE_PROBE ?? "http://fixture-site/index.html";

async function streamLines(url: string): Promise<{ status: number; lines: Record<string, unknown>[] }> {
  const res = await fetch(`${CRAWL4AI}/crawl/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ urls: [url], crawler_config: { stream: true } }),
  });
  const text = await res.text();
  if (res.status !== 200) return { status: res.status, lines: [] };
  const lines = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { status: res.status, lines };
}

test("the streaming route answers per URL even when the only page fails", async () => {
  const { status, lines } = await streamLines(new URL("missing.html", FIXTURE_PAGE).toString());

  // /md cannot report a target's 404 (see "/md cannot replace the stream" below), which is why pages are read this way.
  assert.equal(status, 200, "the stream now fails the whole request; web_scrape would report a 404 as a backend fault");
  const result = lines.find((line) => typeof line.url === "string");
  assert.ok(result, "no per-URL line in the stream");
  assert.equal(result.status_code, 404, "the target's status code is no longer reported per URL");
  assert.ok(
    lines.some((line) => line.status === "completed"),
    "the completion marker is gone",
  );
});

test("a short page is still vetoed as a block, with its markdown kept", async () => {
  const { lines } = await streamLines(new URL("version.txt", FIXTURE_PAGE).toString());
  const result = lines.find((line) => typeof line.url === "string");
  assert.ok(result, "no per-URL line in the stream");

  // Upstream issue #2058. If this starts succeeding, the override in
  // toDocument (src/upstream/crawl4ai.ts) has become dead code.
  //
  // This is the evidence for the override, and it is a reproduced false
  // positive, not an inference from a missing setting: a 200 text file is
  // failed as an anti-bot block, and nothing in the request can switch that off
  // (GET /schema returns defaults only, so its silence proves nothing and is
  // deliberately not asserted on).
  assert.equal(result.success, false, "short pages are no longer vetoed - reconsider the override in toDocument");
  assert.match(String(result.error_message), /^Blocked by anti-bot protection: Structural:/);
  assert.equal(result.status_code, 200);
  const markdown = result.markdown as Record<string, unknown> | undefined;
  assert.match(String(markdown?.raw_markdown), /1\.100\.0/, "the vetoed page's markdown is no longer returned");
});

test("Crawl4AI still returns markdown as an object with raw_markdown", async () => {
  const res = await fetch(`${CRAWL4AI}/crawl`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ urls: [process.env.FIXTURE_PROBE ?? "http://fixture-site/index.html"] }),
  });
  assert.equal(res.status, 200);

  const body = (await res.json()) as { results?: Record<string, unknown>[] };
  const first = body.results?.[0];
  assert.ok(first, "no result returned");
  assert.equal(typeof first.markdown, "object", "markdown changed shape; it is an object, not a string");
  assert.equal(typeof (first.markdown as Record<string, unknown>).raw_markdown, "string");
  assert.ok(first.links && typeof first.links === "object", "links are needed for web_map and web_crawl");
});

test("deep crawling is still refused, which is why the crawl loop exists here", async () => {
  const res = await fetch(`${CRAWL4AI}/crawl`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      urls: [process.env.FIXTURE_PROBE ?? "http://fixture-site/index.html"],
      crawler_config: {
        type: "CrawlerRunConfig",
        params: { deep_crawl_strategy: { type: "BFSDeepCrawlStrategy", params: { max_depth: 2 } } },
      },
    }),
  });

  // If this ever starts succeeding, the breadth-first loop in src/tools/crawl.ts
  // can be deleted and the work handed back to the upstream where it belongs.
  assert.equal(
    res.status,
    400,
    "deep_crawl_strategy is now accepted - reconsider whether web_crawl should still sequence levels itself",
  );

  // Why it is refused matters as much as that it is. This is not a missing
  // feature: the server loads every HTTP body as untrusted and lists
  // deep_crawl_strategy among the fields an untrusted body may never set, next
  // to js_code and proxy_config. No token or setting makes an HTTP caller
  // trusted, so the loop is permanent for as long as this speaks HTTP.
  const detail = String(((await res.json()) as { detail?: unknown }).detail);
  assert.match(
    detail,
    /untrusted/i,
    `the refusal no longer says it is about trust (${detail}) - it may have become a different, fixable, limitation`,
  );
});

test("the asynchronous job route accepts work and can be polled", async () => {
  const submit = await fetch(`${CRAWL4AI}/crawl/job`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ urls: [process.env.FIXTURE_PROBE ?? "http://fixture-site/index.html"] }),
  });
  assert.equal(submit.status, 202);

  const { task_id: taskId } = (await submit.json()) as { task_id?: string };
  assert.ok(taskId, "no task id returned");

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const poll = await fetch(`${CRAWL4AI}/crawl/job/${taskId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(poll.status, 200);
    // Crawl4AI's TaskStatus enum is processing | completed | failed. Anything
    // outside that set is a contract change worth failing on.
    const status = (await poll.json()) as { status?: string };
    if (status.status !== "processing") {
      assert.equal(status.status, "completed", `unexpected terminal status "${status.status}"`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert.fail("the job never finished");
});

// ---------------------------------------------------------------------------
// The guards below pin the reason each remaining workaround exists. A workaround
// nobody re-checks is a guess that outlives its cause; these fail the day the
// cause goes away, and their names say which guarantee was withdrawn.
// ---------------------------------------------------------------------------

const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

test("the job status body still links to the wrong route, which is why the polling URL is built here", async () => {
  const submit = await fetch(`${CRAWL4AI}/crawl/job`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ urls: [FIXTURE_PAGE] }),
  });
  const { task_id: taskId } = (await submit.json()) as { task_id?: string };
  assert.ok(taskId, "no task id returned");

  // `_links` is on the status body, not on the submit response (which carries
  // only the task id). getJobStatus in src/upstream/crawl4ai.ts ignores it.
  const poll = await fetch(`${CRAWL4AI}/crawl/job/${taskId}`, { headers: AUTH });
  const body = (await poll.json()) as { _links?: { self?: { href?: string } } };
  const href = body._links?.self?.href;
  assert.ok(href, "the status body no longer carries _links - the reason for ignoring it is moot, revisit getJobStatus");
  assert.ok(
    !href.includes(`/crawl/job/${taskId}`),
    `_links now points at the job route (${href}): the polling URL could be taken from upstream instead of built here`,
  );
});

test("the extraction route is GET /llm/{url}, the one the documentation does not describe", async () => {
  const res = await fetch(`${CRAWL4AI}/openapi.json`, { headers: AUTH });
  assert.equal(res.status, 200);
  const paths = ((await res.json()) as { paths: Record<string, Record<string, unknown>> }).paths;

  // Needs no model credentials, so it runs everywhere; that the route works
  // when it is called is the keyed test at the end of this file.
  assert.ok(paths["/llm/{url}"]?.get, "GET /llm/{url} is gone - extract() in src/upstream/crawl4ai.ts calls it");
  assert.equal(
    paths["/llm/{path}"],
    undefined,
    "the documented POST /llm/{path} now exists - extract() could use the documented route",
  );
});

test("upstream failures are prose, so error handling has to read the prose", async () => {
  // A host that cannot be reached. Upstream's own address screening answers
  // before any connection is made, and reports it as a 403 anti-bot block.
  const res = await fetch(`${CRAWL4AI}/crawl/stream`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({
      urls: ["http://nonexistent-host-xyz-12345.invalid/"],
      crawler_config: { stream: true },
    }),
  });
  const lines = (await res.text())
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const result = lines.find((line) => typeof line.url === "string");
  assert.ok(result, "no per-URL line in the stream");

  assert.equal(result.success, false);
  assert.equal(typeof result.error_message, "string");
  // resultFailure() sorts failures by matching this text. The day upstream
  // returns a machine-readable kind instead, that matching can be deleted.
  for (const field of ["error_code", "error_type", "failure_type", "code", "kind"]) {
    assert.equal(
      field in result,
      false,
      `upstream now returns "${field}": resultFailure() can classify by it instead of by message text`,
    );
  }
});

test("without a content filter fit_markdown is empty while raw_markdown is not", async () => {
  // The unfiltered read is what web_batch_scrape and web_crawl use. Upstream
  // does not fall back from one variant to the other, so markdownOf() does.
  const { lines } = await streamLines(FIXTURE_PAGE);
  const result = lines.find((line) => typeof line.url === "string");
  assert.ok(result, "no per-URL line in the stream");
  const markdown = result.markdown as { raw_markdown?: string; fit_markdown?: string } | undefined;

  assert.ok((markdown?.raw_markdown ?? "").length > 0, "raw_markdown is empty for an ordinary page");
  assert.equal(
    (markdown?.fit_markdown ?? "").length,
    0,
    "fit_markdown is now filled without a filter - the raw-first preference in markdownOf() may no longer be needed",
  );
});

test("/md cannot replace the stream: a missing page and a short page both fail there", async () => {
  // Why pages are read through /crawl/stream. /md answers one URL with one
  // status, so a target's 404 cannot come back as a 404, and the short-page
  // override (toDocument) has nothing to override because /md never returns the
  // markdown of a page the structural heuristic vetoed.
  const post = (page: string) =>
    fetch(`${CRAWL4AI}/md`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ url: new URL(page, FIXTURE_PAGE).toString(), f: "fit" }),
    });

  const missing = await post("missing.html");
  assert.notEqual(missing.status, 404, "/md now reports a target's 404 as a 404 - it may be usable for single pages");
  assert.notEqual(missing.status, 200, "/md now succeeds on a page that does not exist");

  const short = await post("version.txt");
  assert.notEqual(
    short.status,
    200,
    "/md now returns the short page the stream vetoes - the /crawl/stream read may no longer be needed",
  );
});

// What SearXNG answers depends on what the public engines answered today, and
// from a datacenter address they often answer nothing. So these can only be
// asserted when there are results to look at, and say so when there are not.
async function searchCount(extra: string): Promise<number> {
  const res = await fetch(`${SEARXNG}/search?q=python&format=json&pageno=1${extra}`);
  assert.equal(res.status, 200);
  return ((await res.json()) as { results: unknown[] }).results.length;
}

test("SearXNG has no way to ask for fewer results, which is why the caller counts them", async (t) => {
  const unrestricted = await searchCount("");
  if (unrestricted <= 3) {
    t.skip(`the engines returned ${unrestricted} results, too few to show a limit being ignored`);
    return;
  }
  for (const name of ["limit", "count", "results_per_page", "num"]) {
    const capped = await searchCount(`&${name}=3`);
    assert.ok(
      capped > 3,
      `SearXNG now honours "${name}" (returned ${capped} for ${name}=3): the caller may not need to trim and page itself`,
    );
  }
});

// The one check that needs a model credential. It runs only where a key is in
// the environment, which is a developer machine at version-bump time: CI has
// none, and must not fail for lacking one.
const keyed = process.env.GEMINI_API_KEY
  ? false
  : "GEMINI_API_KEY is not set: the extraction route is only checked where a model credential exists";

test("GET /llm/{url} answers with an extraction, not only a route", { skip: keyed }, async () => {
  const url = `${CRAWL4AI}/llm/${encodeURIComponent(FIXTURE_PAGE)}?q=${encodeURIComponent("What is this page about?")}`;
  const res = await fetch(url, { headers: AUTH });
  assert.equal(res.status, 200, "extraction failed with a model credential present");
  const body = await res.text();
  assert.ok(body.trim().length > 0, "extraction returned nothing");
});
