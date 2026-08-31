import * as m from "./registry.js";
import { BoundedLabelSet, engineFailureReason } from "./normalize.js";
import type { FailureKind } from "../utils/errors.js";
import type { EngineFailure } from "../upstream/types.js";

/**
 * The only way anything records a measurement.
 *
 * Two rules hold for every function here, and the feature is worthless without
 * them:
 *
 *   1. **Nothing throws.** A tool call must never fail because recording it
 *      failed. Every function swallows its own errors.
 *   2. **Disabled means free.** When metrics are off these return at the first
 *      branch, so a deployment with no monitoring pays nothing.
 *
 * Note also what is absent: nothing here knows about the metrics HTTP server.
 * The dependency runs the other way, so a broken exporter cannot reach a tool.
 */

let enabled = false;

/** Turn recording on. Called once at startup when a metrics port is set. */
export function enableMetrics(): void {
  enabled = true;
}

export function disableMetrics(): void {
  enabled = false;
}

export function metricsEnabled(): boolean {
  return enabled;
}

/**
 * Run a recording action, absorbing anything it throws.
 *
 * Deliberately silent: logging a metrics failure on every tool call would turn
 * a cosmetic problem into a flood that buries real messages.
 */
function safely(action: () => void): void {
  if (!enabled) return;
  try {
    action();
  } catch {
    // Recording is best-effort by construction.
  }
}

export type ToolName = string;

export function recordToolCall(
  tool: ToolName,
  outcome: "success" | "failure",
  durationSeconds: number,
  failureKind: FailureKind | null,
): void {
  safely(() => {
    m.toolCalls.inc({ tool, result: outcome });
    m.toolDuration.observe({ tool }, durationSeconds);
    if (outcome === "failure" && failureKind !== null) {
      m.toolFailures.inc({ tool, kind: failureKind });
    }
  });
}

const engines = new BoundedLabelSet();

/**
 * Record a search.
 *
 * Hit count and engine failures are recorded together on purpose: an empty
 * result set is only interpretable alongside whether any engine refused. Split
 * across two calls, a caller could record one and forget the other.
 */
export function recordSearch(
  hitCount: number,
  unresponsive: readonly EngineFailure[],
): void {
  safely(() => {
    m.searchResults.inc({ outcome: hitCount > 0 ? "hits" : "empty" });
    for (const failure of unresponsive) {
      m.engineUnresponsive.inc({
        engine: engines.resolve(failure.engine),
        reason: engineFailureReason(failure.reason),
      });
    }
  });
}

/** Record per-URL fetch outcomes, which are separate from per-call outcomes. */
export function recordDocuments(results: readonly ("ok" | "failed")[]): void {
  safely(() => {
    for (const result of results) m.documents.inc({ result });
  });
}

export type Upstream = "searxng" | "crawl4ai";
export type UpstreamOperation =
  | "search"
  | "markdown"
  | "crawl"
  | "submit_job"
  | "job_status"
  | "extract";

export function recordUpstream(
  upstream: Upstream,
  operation: UpstreamOperation,
  outcome: "success" | "failure",
  durationSeconds: number,
): void {
  safely(() => {
    m.upstreamRequests.inc({ upstream, result: outcome });
    m.upstreamDuration.observe({ upstream, operation }, durationSeconds);
  });
}

export function recordSlots(inUse: number, limit: number): void {
  safely(() => {
    m.fetchSlotsInUse.set(inUse);
    m.fetchSlotsLimit.set(limit);
  });
}

export function recordConcurrencyRejection(): void {
  safely(() => {
    m.concurrencyRejected.inc();
  });
}
