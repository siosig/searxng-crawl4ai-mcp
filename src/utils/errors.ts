/**
 * Failure reporting.
 *
 * Tools do not throw at the caller. An agent reading a stack trace cannot tell
 * "that site is down" from "you are not allowed to fetch that", and the two
 * demand different next moves. So every failure is a value carrying a
 * machine-readable reason.
 */

/**
 * Why something failed, in terms the caller can act on.
 *
 * `egressDenied` and `unreachable` are deliberately distinct. A blocked target
 * is a policy decision about the request; an unreachable one is a fact about
 * the world. Collapsing them would send an agent off retrying a URL that will
 * never be allowed.
 */
export type FailureKind =
  /** Refused by the outbound address policy. Not a network problem. */
  | "egressDenied"
  /** Name resolution or connection failed. The target's problem, not ours. */
  | "unreachable"
  /** The target answered with a 4xx or 5xx. */
  | "httpError"
  /** The target did not finish in time. */
  | "timeout"
  /** The target refused automated access. */
  | "blocked"
  /** All fetch slots are busy. Try again shortly. */
  | "concurrencyLimit"
  /** SearXNG or Crawl4AI is down or misconfigured. Needs an operator. */
  | "upstreamUnavailable"
  /** No LLM credentials configured. Extraction degrades rather than fails. */
  | "llmUnavailable"
  /** The arguments did not pass validation. */
  | "invalidInput";

export interface ToolFailure {
  readonly kind: FailureKind;
  /** Human-readable explanation. Never contains credentials. */
  readonly message: string;
  /** Status returned by the upstream or target, when there was one. */
  readonly upstreamStatus: number | null;
}

export function failure(
  kind: FailureKind,
  message: string,
  upstreamStatus: number | null = null,
): ToolFailure {
  return { kind, message, upstreamStatus };
}

/**
 * Error thrown across internal boundaries when a failure cannot be returned as
 * a value - for example from inside the upstream clients, whose callers turn it
 * back into a `ToolFailure`.
 */
export class UpstreamError extends Error {
  readonly failure: ToolFailure;

  constructor(f: ToolFailure) {
    super(f.message);
    this.name = "UpstreamError";
    this.failure = f;
  }
}

/**
 * Turn anything thrown into a `ToolFailure`.
 *
 * Node reports connection problems through `error.code` rather than through
 * distinct error classes, so those codes are mapped here to keep the guesswork
 * in one place.
 */
export function toFailure(error: unknown): ToolFailure {
  if (error instanceof UpstreamError) return error.failure;

  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    switch (code) {
      case "ENOTFOUND":
      case "EAI_AGAIN":
      case "ECONNREFUSED":
      case "EHOSTUNREACH":
      case "ENETUNREACH":
        return failure("unreachable", `Could not reach the target (${code}).`);
      case "ETIMEDOUT":
      case "UND_ERR_CONNECT_TIMEOUT":
      case "UND_ERR_HEADERS_TIMEOUT":
        return failure("timeout", "The target did not respond in time.");
      default:
        break;
    }
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return failure("timeout", "The request was aborted after the time limit.");
    }
    return failure("upstreamUnavailable", error.message);
  }

  return failure("upstreamUnavailable", String(error));
}
