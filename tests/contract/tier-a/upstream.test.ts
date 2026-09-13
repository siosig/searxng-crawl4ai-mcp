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

  // /md and /crawl answer a bare 500 here, which is why pages are read this way.
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
