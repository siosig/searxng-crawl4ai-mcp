import { setTimeout as sleep } from "node:timers/promises";
import pRetry from "p-retry";
import {
  RETRY_MAX_WAIT_MS,
  RETRY_MIN_WAIT_MS,
  RETRY_WAIT_BUDGET_MS,
} from "../constants.js";
import { env } from "../utils/env.js";
import { UpstreamError, toFailure, type ToolFailure } from "../utils/errors.js";
import {
  recordUpstreamRetry,
  type RetryReason,
  type Upstream,
} from "../metrics/record.js";

/**
 * Whether a failed upstream call gets another go, and how long it waits first.
 *
 * Deliberately ignorant of HTTP. This module never calls `fetch`; it is handed a
 * function and decides whether to run it again. Keeping the decision here rather
 * than in a dispatcher-level retry (undici's `RetryAgent`) is what lets the
 * per-attempt timeout in http.ts stay per-attempt - a dispatcher retries beneath
 * our `AbortSignal`, which would silently turn that signal into a ceiling on the
 * whole series and take the third stage below with it.
 *
 * The rules are stated in specs/003-search-controls-retry-stdio/contracts/retry.md
 * and are implemented one-for-one as three stages in `shouldRetry`.
 */

export interface RetryPolicy {
  /** Attempts including the first. 1 - or 0, read the same way - never retries. */
  readonly attempts: number;
  /** Wait before the first retry, before jitter. */
  readonly minWaitMs: number;
  /** Ceiling on a single wait, before jitter. */
  readonly maxWaitMs: number;
  /** Total time retrying may add on top of the per-attempt timeout. */
  readonly waitBudgetMs: number;
}

/** The policy the running process is configured for. */
export function envPolicy(): RetryPolicy {
  return {
    attempts: env().RETRY_MAX_ATTEMPTS,
    minWaitMs: RETRY_MIN_WAIT_MS,
    maxWaitMs: RETRY_MAX_WAIT_MS,
    waitBudgetMs: RETRY_WAIT_BUDGET_MS,
  };
}

/**
 * A failure that came with the upstream's own opinion on when to come back.
 *
 * A subclass rather than a field on `ToolFailure`, because `Retry-After` is
 * advice about the *next* attempt and has no meaning to the caller that
 * eventually reads the failure - putting it in the value every tool returns
 * would be inviting someone to act on it in a place that cannot retry.
 */
export class RetryAfterError extends UpstreamError {
  readonly retryAfterMs: number;

  constructor(f: ToolFailure, retryAfterMs: number) {
    super(f);
    this.name = "RetryAfterError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Read a `Retry-After` header, which is either delta-seconds or an HTTP date.
 *
 * Anything unparseable, negative, or absurdly far out is reported as "no
 * advice" rather than as a huge wait: a malformed header is the upstream's bug,
 * and treating it as an instruction would let one bad header decide our
 * behaviour. An absent header is the ordinary case, not an error.
 */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const raw = value.trim();
  if (raw === "") return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds * 1000 : null;
  }

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  const ms = at - Date.now();
  return ms > 0 ? ms : 0;
}

/**
 * Statuses that mean "the upstream is having a moment", as opposed to "the
 * upstream is telling you something about your request".
 *
 * 501 is absent on purpose although it is a 5xx: a route that is not
 * implemented will not be implemented by the next attempt either.
 */
const TRANSIENT_SERVER_STATUS = new Set([500, 502, 503, 504]);

/** Statuses that are a 4xx but describe timing rather than the request. */
const TRANSIENT_CLIENT_STATUS = new Set([408, 425]);

/**
 * Stage 2: is this the kind of failure that repeating could fix, and under
 * which of the metric's four buckets does it belong?
 *
 * `null` means "not transient", which is the answer for every kind not listed.
 * Note `upstreamUnavailable` among the silent ones: it carries 401/403 and
 * non-JSON bodies, and neither a wrong credential nor a proxy's error page
 * turns into a good response by asking again.
 */
export function retryReason(f: ToolFailure): RetryReason | null {
  switch (f.kind) {
    case "unreachable":
      return "connect";
    case "timeout":
      // Classified as transient, and then almost always refused by stage 3: a
      // request that spent its whole timeout has no room left in the budget.
      // The classification and the execution are kept separate so that an
      // operation with a short enough timeout can still be retried.
      return "timeout";
    case "httpError": {
      const status = f.upstreamStatus;
      if (status === null) return null;
      if (status === 429) return "rate_limited";
      if (TRANSIENT_CLIENT_STATUS.has(status)) return "connect";
      if (TRANSIENT_SERVER_STATUS.has(status)) return "http_5xx";
      return null;
    }
    default:
      return null;
  }
}

export interface RetryOptions {
  /**
   * Whether running `work` twice can leave the upstream in a different state
   * than running it once. Stage 1 of the contract.
   */
  readonly idempotent: boolean;
  /** Which upstream a performed retry is attributed to in the metrics. */
  readonly upstream?: Upstream;
  /** Overrides the process-wide policy. Tests use this; production does not. */
  readonly policy?: RetryPolicy;
}

/**
 * Run `work`, repeating it while all three stages of the contract agree.
 *
 * The guarantee this buys is a single sentence: retrying never makes a call
 * take more than `waitBudgetMs` longer than it would have without retrying.
 * That falls out of the stage 3 inequality rather than out of any per-operation
 * table, which is why there is no list here of which calls may be retried.
 */
export async function withRetry<T>(
  work: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const policy = options.policy ?? envPolicy();

  // With no second attempt on offer there is nothing for the stages to decide.
  // Short-circuiting rather than passing `retries: 0` keeps the disabled path
  // free of any wrapper between the caller and the error it used to get
  // directly - "retrying is off" has to mean the behaviour from before retrying
  // existed, not a close approximation of it.
  if (policy.attempts <= 1) return work();

  const startedAt = performance.now();

  return pRetry(work, {
    retries: policy.attempts - 1,
    factor: 2,
    minTimeout: policy.minWaitMs,
    maxTimeout: policy.maxWaitMs,
    // Multiplies each wait by 1-2. Not full jitter, but enough that a fleet of
    // callers knocked over by the same upstream blip does not come back in step.
    randomize: true,
    // `unref: true` is deliberately NOT set.
    //
    // It reads as tidy - why would a sleeping timer hold the process open? -
    // but a backoff between attempts is the middle of a request someone is
    // waiting on, not background housekeeping. Unreferenced, it is the only
    // handle left whenever nothing else happens to be in flight, so the loop
    // drains and the call is abandoned partway through. That surfaced first as
    // ten retry tests being cancelled mid-flight on a CI runner, but the same
    // shape would drop real work during a quiet moment or a shutdown.
    //
    // The graceful-shutdown paths in the transports are what bound how long a
    // process lingers; a retry is work to be finished, not work to be skipped.
    shouldRetry: async (context): Promise<boolean> => {
      // Stage 1: side effects.
      //
      // The default lives in http.ts (`GET`), and anything else has to say so.
      // The direction matters more than the rule: someone adding a POST who
      // writes nothing gets the safe answer.
      if (!options.idempotent) return false;

      // Stage 2: kind of failure.
      const reason = retryReason(toFailure(context.error));
      if (reason === null) return false;

      // Stage 3: time budget.
      //
      // `retryDelay` is the real, post-jitter wait - p-retry runs this callback
      // after it has settled on one - so nothing here is an approximation. When
      // the upstream named a time of its own, that is the wait being tested,
      // which is how "Retry-After longer than the remaining budget" ends up
      // refusing the retry without a rule of its own.
      const elapsedMs = performance.now() - startedAt;
      const advised = context.error instanceof RetryAfterError
        ? context.error.retryAfterMs
        : 0;
      const waitMs = Math.max(context.retryDelay, advised);
      if (elapsedMs + waitMs > policy.waitBudgetMs) return false;

      // p-retry is about to wait `retryDelay`; make up the difference so that
      // an upstream which asked for more time actually gets it. Re-entering
      // earlier than we were told is the rudeness the budget check above was
      // written to avoid, and here it costs nothing to avoid it properly.
      const shortfall = waitMs - context.retryDelay;
      // Referenced, like the backoff itself. An unreferenced timer here would
      // be the only handle left whenever nothing else is in flight, and the
      // loop would drain in the middle of a call that is waiting to finish.
      if (shortfall > 0) await sleep(shortfall);

      // Counted here, not in `onFailedAttempt`, because that hook runs before
      // this decision and would therefore count attempts that were only
      // considered. The metric's help says retries made.
      if (options.upstream !== undefined) {
        recordUpstreamRetry(options.upstream, reason);
      }
      return true;
    },
  });
}
