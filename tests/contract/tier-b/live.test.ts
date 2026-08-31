import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { clientFromEnv } from "../client.js";

/**
 * The public internet.
 *
 * These are reported but do not gate a merge. A datacenter IP being served a
 * CAPTCHA says something about where CI runs, not about whether this code is
 * correct - and letting that stop an upstream update would defeat the point of
 * being able to follow upstream at all.
 *
 * Not gating is only half of it, though. A job that is red every time carries
 * no information: the third failure hides among the two everyone has learned to
 * expect, and the tier stops being read at all. So a test here fails only when
 * something is actually wrong, and says "skipped, and why" when the engines or
 * the credentials simply were not available to answer the question.
 *
 * The line between the two is drawn with what the server itself reports. An
 * empty result set alongside a refusal is the environment; an empty result set
 * with every engine answering is this code.
 */

const client = clientFromEnv();

interface EngineFailure {
  readonly engine: string;
  readonly reason: string;
}

function refusals(structured: Record<string, unknown>): EngineFailure[] {
  return (structured.unresponsiveEngines as EngineFailure[] | undefined) ?? [];
}

function describe(failures: readonly EngineFailure[]): string {
  return failures.map((e) => `${e.engine} (${e.reason})`).join(", ") || "none";
}

/**
 * Stand down when no engine was in a position to answer.
 *
 * Returns true when the test should stop. The caller keeps the judgement about
 * what "nothing came back" means for it; this only reports the one situation
 * where the question could not be put to anybody.
 */
function noEngineAnswered(
  t: TestContext,
  structured: Record<string, unknown>,
  what: string,
): boolean {
  const failures = refusals(structured);
  if (failures.length === 0) return false;
  const results = (structured.results as unknown[] | undefined) ?? [];
  if (results.length > 0) return false;

  t.skip(`${what}: every engine refused - ${describe(failures)}`);
  return true;
}

test("a real search returns real hits", async (t) => {
  const { structured } = await client.call("web_search", {
    query: "model context protocol specification",
    limit: 5,
  });
  if (noEngineAnswered(t, structured, "cannot tell whether search works")) return;

  const results = structured.results as unknown[];
  assert.ok(
    results.length > 0,
    "every engine answered and none had anything; that is this server, not the web",
  );
});

test("narrowing to a period changes which pages come back", async (t) => {
  // A subject that is written about continuously, so "this week" and "ever"
  // genuinely differ. The assertion is that the filter reached the engines at
  // all - proving the dates are inside the window would mean trusting result
  // metadata that most engines do not return.
  const query = "typescript release notes";
  const unfiltered = await client.call("web_search", { query, limit: 10 });
  const recent = await client.call("web_search", { query, limit: 10, timeRange: "week" });

  if (noEngineAnswered(t, recent.structured, "cannot tell whether timeRange reached the engines")) {
    return;
  }

  const urls = (r: typeof unfiltered): string[] =>
    (r.structured.results as { url: string }[]).map((h) => h.url);

  assert.ok(urls(recent).length > 0, "a week is not too narrow for this subject");
  assert.notDeepEqual(
    urls(recent),
    urls(unfiltered),
    "the same hits in the same order means time_range never reached the engines",
  );
});

test("narrowing to one engine leaves results from only that engine", async (t) => {
  const engine = "duckduckgo";
  const { structured } = await client.call("web_search", {
    query: "model context protocol",
    limit: 5,
    engines: [engine],
  });

  const results = structured.results as { url: string; engines: string[] }[];
  const failures = refusals(structured);

  // The one engine asked was the one turned away, so there is nothing to check
  // the narrowing against. This is the common case from a datacenter address
  // and it is not a finding.
  if (results.length === 0 && failures.some((f) => f.engine.toLowerCase().includes(engine))) {
    t.skip(`${engine} was refused - ${describe(failures)}`);
    return;
  }

  assert.ok(
    results.length > 0,
    `${engine} answered but returned nothing, which is a narrowing problem rather than a blocked engine. ` +
      `Refusals: ${describe(failures)}`,
  );

  const sources = new Set(results.flatMap((h) => h.engines));
  assert.deepEqual(
    [...sources],
    [engine],
    "a hit from any other engine means the engines parameter was not honoured",
  );
});

test("a real page can be fetched", async () => {
  // No skip here on purpose. This one needs no search engine and no
  // credentials, so it is the tier's canary: if everything else stands down and
  // this still passes, the deployment reaches the internet and the scraping
  // path works. If this fails, something is genuinely broken.
  const { structured } = await client.call("web_scrape", { url: "https://example.com" });
  assert.equal(structured.status, "ok", JSON.stringify(structured.failure));
  assert.match(String(structured.markdown), /Example Domain/);
});

test("structured extraction works with real credentials", async (t) => {
  const { structured } = await client.call("web_extract", {
    url: "https://example.com",
    instruction: "the page title",
  });

  // Degrading without credentials is the documented behaviour, and the Tier A
  // job proves it happens. Asserting it here as a failure only reported, every
  // run, that this environment has no key - which is a fact about the
  // environment and was never going to change on its own.
  if (structured.degraded === true) {
    t.skip("no model credentials in this environment; extraction degraded as designed");
    return;
  }

  assert.equal(structured.failure, null, JSON.stringify(structured.failure));
  assert.notEqual(structured.data, null);
});
