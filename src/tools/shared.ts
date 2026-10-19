import type { CallToolResult } from "@modelcontextprotocol/server";
import { CHARACTER_LIMIT } from "../constants.js";
import { checkEgress } from "../security/egress.js";
import { env } from "../utils/env.js";
import { failure, toFailure, type ToolFailure } from "../utils/errors.js";
import { fit, type TrimStep } from "../utils/fit.js";
import { Slots } from "../utils/semaphore.js";
import { logger } from "../utils/logger.js";
import type { FetchedDocument } from "../upstream/types.js";
import { recordToolCall, recordDocuments } from "../metrics/record.js";

/**
 * Machinery shared by every tool: the fetch budget, the outbound check, and a
 * single place where a result is turned into an MCP response.
 */

let slots: Slots | null = null;

/** The fetch budget, created on first use so tests can reset it. */
export function fetchSlots(): Slots {
  slots ??= new Slots(env().MAX_CONCURRENT_FETCHES);
  return slots;
}

export function resetSlotsForTest(): void {
  slots = null;
}

export const ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Build an MCP response whose text is the JSON serialization of its structured
 * content.
 *
 * `structured` is fitted under the size cap with the tool's own `steps`, which
 * say what to cut first. `truncated` and `truncation` are reserved for that cap
 * and are set here, so `structured` may not carry either: a tool's own field
 * under one of those names would be overwritten.
 *
 * `limit` is the caller's maxChars. Failures keep the default: they are small,
 * and a schema violation never reaches a tool.
 */
export function reply(
  structured: Record<string, unknown> & { readonly truncated?: never; readonly truncation?: never },
  steps: readonly TrimStep[] = [],
  limit: number = CHARACTER_LIMIT,
): CallToolResult {
  const { value, text } = fit(structured, steps, limit);
  return {
    content: [{ type: "text", text }],
    structuredContent: value,
  };
}

/**
 * Report a failure as a result rather than a thrown error.
 *
 * `isError` is what makes the result legible *as* a failure. The protocol
 * treats a result without it as a successful call - "If not set, the call is
 * assumed to be successful" - so a body that merely describes a failure arrives
 * at the client as a success whose text happens to be discouraging. Setting it
 * is what lets a client surface the call as failed and lets a model recognise
 * that it should try something else.
 *
 * The flag belongs here and only here. A batch in which some URLs could not be
 * fetched is *not* a failed call: it did the work it was asked to do and is
 * reporting per-URL outcomes, so those stay inside an ordinary result. What
 * this function marks is the other thing - the whole call could not be carried
 * out.
 */
export function replyFailure(f: ToolFailure): CallToolResult {
  return { ...reply({ status: "failed", failure: f }), isError: true };
}

/**
 * Run a tool body, converting anything thrown into a reported failure.
 *
 * A thrown error would reach the model as a protocol-level fault with no
 * indication of what to do next; a `ToolFailure` names the cause and implies
 * the next move.
 */
export async function guarded(name: string, body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  // Every tool goes through here, so this is the one place that needs to know
  // how a call is measured. Adding a tool cannot forget to be counted.
  const started = process.hrtime.bigint();
  const elapsed = (): number => Number(process.hrtime.bigint() - started) / 1e9;

  try {
    const result = await body();
    // A tool that reported a failure as a value is a failure, even though
    // nothing was thrown. Counting it as a success would make the dashboard
    // claim everything is fine while every fetch is being refused.
    const failure = (result.structuredContent as { failure?: ToolFailure | null } | undefined)
      ?.failure;
    if (failure) {
      recordToolCall(name, "failure", elapsed(), failure.kind);
    } else {
      recordToolCall(name, "success", elapsed(), null);
    }
    return result;
  } catch (error) {
    const f = toFailure(error);
    recordToolCall(name, "failure", elapsed(), f.kind);
    logger.warn({ tool: name, kind: f.kind, status: f.upstreamStatus }, "tool failed");
    return replyFailure(f);
  }
}

/** Count fetch outcomes per URL, which is a different question from per call. */
export function countDocuments(docs: readonly FetchedDocument[]): void {
  recordDocuments(docs.map((d) => (d.status === "ok" ? "ok" : "failed")));
}

/**
 * Refuse a target that outbound policy forbids, before any browser starts.
 * Returns the failure, or null when the URL may be fetched.
 */
export async function egressGuard(url: string): Promise<ToolFailure | null> {
  const decision = await checkEgress(url, { allow: env().SCRAPE_ALLOW_CIDRS });
  if (decision.allowed) return null;
  return decision.failure ?? failure("egressDenied", "The target is not allowed.");
}

/** Filter a list of URLs, returning the allowed ones and a failure per refusal. */
export async function partitionByEgress(
  urls: readonly string[],
): Promise<{ allowed: string[]; refused: Map<string, ToolFailure> }> {
  const refused = new Map<string, ToolFailure>();
  const allowed: string[] = [];
  await Promise.all(
    urls.map(async (url) => {
      const f = await egressGuard(url);
      if (f === null) allowed.push(url);
      else refused.set(url, f);
    }),
  );
  return { allowed, refused };
}
