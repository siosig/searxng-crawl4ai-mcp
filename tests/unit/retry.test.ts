import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  RETRY_MAX_WAIT_MS,
  RETRY_MIN_WAIT_MS,
  RETRY_WAIT_BUDGET_MS,
} from "../../src/constants.js";
import {
  RetryAfterError,
  parseRetryAfter,
  retryReason,
  withRetry,
  type RetryPolicy,
} from "../../src/upstream/retry.js";
import { request } from "../../src/upstream/http.js";
import { failure, UpstreamError, type FailureKind } from "../../src/utils/errors.js";
import { setEnvForTest, type Env } from "../../src/utils/env.js";
import { disableMetrics, enableMetrics } from "../../src/metrics/record.js";
import { registry } from "../../src/metrics/registry.js";

/**
 * The three stages of specs/003-search-controls-retry-stdio/contracts/retry.md,
 * one section each.
 *
 * Waits are scaled down rather than mocked. The stage 3 rule is an inequality
 * between an elapsed time and a wait, so shrinking both sides by the same factor
 * leaves exactly the behaviour being tested while keeping the file under a
 * couple of seconds. The one test that must not be scaled is the SC-008
 * guarantee itself, which runs on the real constants.
 */

/** Waits small enough to be free, budget large enough not to be the subject. */
const FAST: RetryPolicy = {
  attempts: 3,
  minWaitMs: 1,
  maxWaitMs: 2,
  waitBudgetMs: 2_000,
};

function upstreamError(kind: FailureKind, status: number | null = null): UpstreamError {
  return new UpstreamError(failure(kind, `synthetic ${kind}`, status));
}

/** A unit of work that fails `times` times and then succeeds. */
function failing(error: Error, times = Number.POSITIVE_INFINITY) {
  let calls = 0;
  return {
    calls: (): number => calls,
    work: async (): Promise<string> => {
      calls += 1;
      if (calls <= times) throw error;
      return "ok";
    },
  };
}

async function attemptsFor(
  error: Error,
  options: { idempotent: boolean; policy?: RetryPolicy },
): Promise<number> {
  const target = failing(error);
  await assert.rejects(
    withRetry(target.work, {
      idempotent: options.idempotent,
      policy: options.policy ?? FAST,
    }),
  );
  return target.calls();
}

// --- The story the feature exists for ---------------------------------------

test("a call whose first attempt fails succeeds from the caller's side", async () => {
  const target = failing(upstreamError("unreachable"), 1);
  const result = await withRetry(target.work, { idempotent: true, policy: FAST });

  assert.equal(result, "ok");
  assert.equal(target.calls(), 2, "the failure should have cost an attempt, not the call");
});

// --- Stage 1: idempotency ----------------------------------------------------

test("stage 1 refuses anything that has not been declared repeatable", async () => {
  const transient = upstreamError("unreachable");

  assert.equal(await attemptsFor(transient, { idempotent: true }), 3);
  assert.equal(
    await attemptsFor(transient, { idempotent: false }),
    1,
    "a request that may leave a side effect is not repeated, transient or not",
  );
});

test("the declaration defaults to GET, and a POST has to opt in", async () => {
  // Exercised through request() because the default is http.ts's to make: the
  // policy module is handed a boolean and never sees a method.
  setEnvForTest({ RETRY_MAX_ATTEMPTS: 2 } as unknown as Env);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  }) as typeof fetch;

  try {
    calls = 0;
    await assert.rejects(request("http://upstream.invalid/x", { method: "GET" }));
    assert.equal(calls, 2, "GET is repeatable by definition");

    calls = 0;
    await assert.rejects(request("http://upstream.invalid/x", { method: "POST", body: {} }));
    assert.equal(calls, 1, "an undeclared POST falls to the safe side");

    calls = 0;
    await assert.rejects(
      request("http://upstream.invalid/x", { method: "POST", body: {}, idempotent: true }),
    );
    assert.equal(calls, 2, "a POST the call site vouched for is repeated");
  } finally {
    globalThis.fetch = original;
    setEnvForTest(null);
  }
});

// --- Stage 2: kind of failure ------------------------------------------------

test("stage 2 classifies exactly the failures the contract lists", () => {
  const kind = (k: FailureKind, status: number | null = null): ReturnType<typeof retryReason> =>
    retryReason(failure(k, "", status));

  assert.equal(kind("unreachable"), "connect");
  assert.equal(kind("timeout"), "timeout");

  for (const status of [500, 502, 503, 504]) {
    assert.equal(kind("httpError", status), "http_5xx", `${status} is the upstream straining`);
  }
  for (const status of [408, 425]) {
    assert.equal(kind("httpError", status), "connect", `${status} is about timing`);
  }
  assert.equal(kind("httpError", 429), "rate_limited");

  // 501 is a 5xx that will still be unimplemented on the next attempt.
  for (const status of [400, 401, 403, 404, 409, 422, 501]) {
    assert.equal(kind("httpError", status), null, `${status} is about the request`);
  }

  for (const k of [
    "egressDenied",
    "invalidInput",
    "concurrencyLimit",
    "llmUnavailable",
    "upstreamUnavailable",
    "blocked",
  ] as const) {
    assert.equal(kind(k), null, `${k} does not become true by asking again`);
  }
});

test("a refusal is not retried, however it reaches us", async () => {
  // 403 arrives as upstreamUnavailable from http.ts and as httpError from
  // anything that classifies a status itself. Neither may be retried.
  assert.equal(await attemptsFor(upstreamError("httpError", 403), { idempotent: true }), 1);
  assert.equal(
    await attemptsFor(upstreamError("upstreamUnavailable", 403), { idempotent: true }),
    1,
  );
  assert.equal(
    await attemptsFor(upstreamError("egressDenied"), { idempotent: true }),
    1,
    "a blocked address is a policy decision, and policy does not flap",
  );
});

// --- Stage 3: time budget ----------------------------------------------------

test("stage 3 separates a fast failure from one that spent its whole timeout", async () => {
  // Scaled: a 40ms attempt against a 30ms budget stands in for a 30s attempt
  // against a 2s one. The inequality is the same either way.
  const scaled: RetryPolicy = { attempts: 3, minWaitMs: 5, maxWaitMs: 10, waitBudgetMs: 30 };

  const quick = failing(upstreamError("timeout"));
  await assert.rejects(withRetry(quick.work, { idempotent: true, policy: scaled }));
  assert.ok(quick.calls() > 1, "a failure that cost nothing leaves room to try again");

  let slowCalls = 0;
  const slow = async (): Promise<never> => {
    slowCalls += 1;
    await sleep(40);
    throw upstreamError("timeout");
  };
  await assert.rejects(withRetry(slow, { idempotent: true, policy: scaled }));
  assert.equal(
    slowCalls,
    1,
    "an attempt that used up the budget on its own leaves nothing to retry with",
  );
});

test("SC-008: retrying never adds more than the wait budget", async () => {
  // The real constants, deliberately. This is the guarantee, not an example of
  // it, so scaling it down would test something else.
  const production: RetryPolicy = {
    attempts: 5,
    minWaitMs: RETRY_MIN_WAIT_MS,
    maxWaitMs: RETRY_MAX_WAIT_MS,
    waitBudgetMs: RETRY_WAIT_BUDGET_MS,
  };

  const target = failing(upstreamError("httpError", 503));
  const started = performance.now();
  await assert.rejects(withRetry(target.work, { idempotent: true, policy: production }));
  const elapsed = performance.now() - started;

  // The work itself is instant, so everything measured here is wait. The slack
  // is for timer overshoot only; it is not part of the guarantee.
  assert.ok(
    elapsed <= RETRY_WAIT_BUDGET_MS + 200,
    `retries added ${Math.round(elapsed)}ms, over the ${RETRY_WAIT_BUDGET_MS}ms budget`,
  );
  assert.ok(target.calls() > 1, "the budget must allow at least one retry of an instant failure");
});

// --- Retry-After -------------------------------------------------------------

test("Retry-After is read as seconds or as a date, and never as an instruction to trust", () => {
  assert.equal(parseRetryAfter("2"), 2_000);
  assert.equal(parseRetryAfter(" 0 "), 0);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(""), null);
  assert.equal(parseRetryAfter("-5"), null, "a negative delay is a malformed header");
  assert.equal(parseRetryAfter("soon"), null);

  const future = parseRetryAfter(new Date(Date.now() + 10_000).toUTCString());
  assert.ok(future !== null && future > 8_000 && future <= 10_000);
  assert.equal(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString()), 0);
});

test("a 429 that asks for longer than the budget is given up on rather than rushed", async () => {
  const tooLong = new RetryAfterError(failure("httpError", "slow down", 429), 5_000);
  assert.equal(
    await attemptsFor(tooLong, { idempotent: true }),
    1,
    "waiting as asked would break the budget, and re-entering sooner would be rude",
  );
});

test("a 429 that fits in the budget is waited out in full", async () => {
  const advised = new RetryAfterError(failure("httpError", "slow down", 429), 30);
  const target = failing(advised, 1);

  const started = performance.now();
  const result = await withRetry(target.work, { idempotent: true, policy: FAST });
  const elapsed = performance.now() - started;

  assert.equal(result, "ok");
  assert.ok(
    elapsed >= 25,
    `came back after ${Math.round(elapsed)}ms although the upstream asked for 30ms`,
  );
});

// --- Disabling ---------------------------------------------------------------

test("RETRY_MAX_ATTEMPTS of 1 or 0 leaves the call exactly as it was", async () => {
  for (const attempts of [1, 0]) {
    const original = upstreamError("unreachable");
    const target = failing(original);
    const policy: RetryPolicy = { ...FAST, attempts };

    const thrown = await withRetry(target.work, { idempotent: true, policy }).then(
      () => null,
      (error: unknown) => error,
    );

    assert.equal(target.calls(), 1, `attempts=${attempts} must not try twice`);
    assert.equal(
      thrown,
      original,
      "the caller must receive the very error it would have without retrying",
    );
  }
});

// --- Metrics -----------------------------------------------------------------

test("only retries that happened are counted", async () => {
  enableMetrics();
  try {
    await assert.rejects(
      withRetry(failing(upstreamError("unreachable")).work, {
        idempotent: true,
        upstream: "searxng",
        policy: FAST,
      }),
    );

    // Considered and refused at stage 2: nothing performed, nothing counted.
    await assert.rejects(
      withRetry(failing(upstreamError("httpError", 404)).work, {
        idempotent: true,
        upstream: "crawl4ai",
        policy: FAST,
      }),
    );

    const text = await registry.metrics();
    assert.match(text, /mcp_upstream_retries_total\{upstream="searxng",reason="connect"\} 2/);
    assert.ok(
      !text.includes('mcp_upstream_retries_total{upstream="crawl4ai"'),
      "a retry that was only considered must not appear",
    );
  } finally {
    disableMetrics();
  }
});
