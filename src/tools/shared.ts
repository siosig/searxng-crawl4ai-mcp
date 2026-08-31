import type { CallToolResult } from "@modelcontextprotocol/server";
import { checkEgress } from "../security/egress.js";
import { env } from "../utils/env.js";
import { failure, toFailure, type ToolFailure } from "../utils/errors.js";
import { truncate, cell } from "../utils/format.js";
import { Slots } from "../utils/semaphore.js";
import { logger } from "../utils/logger.js";
import type { FetchedDocument } from "../upstream/types.js";
import type { Format } from "../schemas/tools.js";
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

/** Build an MCP response, truncating oversized output and reporting that it did. */
export function reply(
  markdown: string,
  structured: Record<string, unknown>,
  format: Format,
): CallToolResult {
  const body = format === "json" ? JSON.stringify(structured, null, 2) : markdown;
  const { text, truncated } = truncate(body);
  return {
    content: [{ type: "text", text }],
    structuredContent: { ...structured, truncated },
  };
}

/** Report a failure as a normal result. Tools do not throw at the caller. */
export function replyFailure(f: ToolFailure, format: Format): CallToolResult {
  const markdown = `**Failed (${f.kind})**: ${f.message}`;
  return reply(markdown, { status: "failed", failure: f }, format);
}

/**
 * Run a tool body, converting anything thrown into a reported failure.
 *
 * A thrown error would reach the model as a protocol-level fault with no
 * indication of what to do next; a `ToolFailure` names the cause and implies
 * the next move.
 */
export async function guarded(
  name: string,
  format: Format,
  body: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
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
    return replyFailure(f, format);
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

export function documentMarkdown(doc: FetchedDocument): string {
  if (doc.status === "failed") {
    return `### ${doc.url}\n\n**Failed (${doc.failure?.kind})**: ${doc.failure?.message}\n`;
  }
  const heading = doc.title ? `### ${doc.title}\n\n${doc.url}` : `### ${doc.url}`;
  return `${heading}\n\n${doc.markdown ?? ""}\n`;
}

export function documentsMarkdown(docs: readonly FetchedDocument[]): string {
  const ok = docs.filter((d) => d.status === "ok").length;
  const header =
    docs.length > 1
      ? `${ok} of ${docs.length} pages fetched.\n\n`
      : "";
  return header + docs.map(documentMarkdown).join("\n---\n\n");
}

export { cell };
