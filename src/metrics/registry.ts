import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "@prometheus-io/client";

/**
 * The metric definitions.
 *
 * Names and labels here are a published contract - a dashboard reads them and
 * a time-series database has already stored them under these names, so
 * renaming one breaks both. See specs/002-operational-metrics/contracts/metrics.md.
 *
 * Every label below has a value set that can be written down in advance. That
 * is the whole discipline: no URLs, no queries, no job ids, nothing an upstream
 * chose the wording of.
 */

export const registry = new Registry();

// Memory, event-loop delay and GC. The deployment target has four cores and
// little spare memory, so being able to tell "this server is the one eating
// it" from "something else is" is worth the handful of extra series.
collectDefaultMetrics({ register: registry });

export const toolCalls = new Counter({
  name: "mcp_tool_calls_total",
  help: "Tool calls, by tool and whether they succeeded.",
  labelNames: ["tool", "result"] as const,
  registers: [registry],
});

export const toolFailures = new Counter({
  name: "mcp_tool_failures_total",
  help: "Failed tool calls broken down by cause.",
  labelNames: ["tool", "kind"] as const,
  registers: [registry],
});

export const toolDuration = new Histogram({
  name: "mcp_tool_duration_seconds",
  help: "How long a tool call took, end to end.",
  labelNames: ["tool"] as const,
  // Fetching a page runs a browser, so the interesting range runs from a
  // fraction of a second to a couple of minutes.
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [registry],
});

export const searchResults = new Counter({
  name: "mcp_search_results_total",
  help: "Searches, by whether they returned anything.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const engineUnresponsive = new Counter({
  name: "mcp_search_engine_unresponsive_total",
  help: "Search engines that did not answer, by engine and classified reason.",
  labelNames: ["engine", "reason"] as const,
  registers: [registry],
});

export const documents = new Counter({
  name: "mcp_documents_total",
  help: "Pages fetched, counted per URL rather than per call.",
  labelNames: ["result"] as const,
  registers: [registry],
});

export const upstreamRequests = new Counter({
  name: "mcp_upstream_requests_total",
  help: "Requests made to an upstream service.",
  labelNames: ["upstream", "result"] as const,
  registers: [registry],
});

export const upstreamDuration = new Histogram({
  name: "mcp_upstream_duration_seconds",
  help: "Time spent waiting on an upstream service.",
  labelNames: ["upstream", "operation"] as const,
  buckets: [0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [registry],
});

export const fetchSlotsInUse = new Gauge({
  name: "mcp_fetch_slots_in_use",
  help: "Fetch slots currently occupied.",
  registers: [registry],
});

export const fetchSlotsLimit = new Gauge({
  name: "mcp_fetch_slots_limit",
  help: "Total fetch slots available.",
  registers: [registry],
});

export const concurrencyRejected = new Counter({
  name: "mcp_concurrency_rejected_total",
  help: "Calls refused because every fetch slot was busy.",
  registers: [registry],
});
