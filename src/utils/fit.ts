/**
 * Fitting a structured result under the size cap.
 *
 * The response text is `JSON.stringify` of `structuredContent`, so it must stay
 * valid JSON at every size. Cutting the serialized string would leave it
 * unparseable; instead the value is reduced from the inside - arrays lose their
 * tails, strings are shortened - and serialized afterwards. The text and the
 * structured value therefore always carry the same content.
 */

import { CHARACTER_LIMIT } from "../constants.js";

export interface Cut {
  /** JSON Pointer (RFC 6901). A "*" segment stands for every element of an array. "" is the whole result. */
  readonly path: string;
  /** "chars": a string was shortened (or a value was dropped). "items": an array lost elements from its end. */
  readonly unit: "chars" | "items";
  /** Length before cutting: string .length (UTF-16 code units) for a string, serialized length for a dropped non-string value, or element count. */
  readonly original: number;
  /** Length after cutting, in the same unit. */
  readonly kept: number;
}

export interface Truncation {
  /** The cap the text was fitted to (CHARACTER_LIMIT). */
  readonly limit: number;
  /** Length of the text the untrimmed result would have produced, with truncated: false and truncation: null. */
  readonly originalLength: number;
  /** What was removed, in the order the cuts were made. */
  readonly cuts: readonly Cut[];
  /** TRUNCATION_ADVICE. */
  readonly advice: string;
}

export type TrimStep =
  | { readonly kind: "documents"; readonly path: string }
  | { readonly kind: "text"; readonly path: string }
  | { readonly kind: "items"; readonly path: string }
  | { readonly kind: "drop"; readonly path: string };

export interface Fitted {
  /** The result to put in structuredContent, ending in truncated and truncation. */
  readonly value: Record<string, unknown>;
  /** JSON.stringify(value). */
  readonly text: string;
}

export const TRUNCATION_ADVICE =
  "The response exceeded the size limit and was reduced; cuts lists what was removed. " +
  "Narrow the request - fewer URLs, a lower page limit, or a more specific query.";

interface Ctx {
  readonly limit: number;
  readonly originalLength: number;
}

type Draft = Record<string, unknown>;
type Container = Draft | unknown[];

/** One row of the JSON string-escaping table: serialized cost and UTF-16 code units consumed. */
function unitAt(s: string, i: number): { cost: number; width: number } {
  const c = s.charCodeAt(i);
  if (c === 0x22 || c === 0x5c) return { cost: 2, width: 1 };
  if (c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) return { cost: 2, width: 1 };
  if (c < 0x20) return { cost: 6, width: 1 };
  if (c >= 0xd800 && c <= 0xdbff) {
    const next = s.charCodeAt(i + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return { cost: 2, width: 2 };
  }
  if (c >= 0xd800 && c <= 0xdfff) return { cost: 6, width: 1 };
  return { cost: 1, width: 1 };
}

/** Length of the string as it appears inside JSON quotes; equals `JSON.stringify(s).length - 2`. */
export function serializedCost(s: string): number {
  let total = 0;
  let i = 0;
  while (i < s.length) {
    const { cost, width } = unitAt(s, i);
    total += cost;
    i += width;
  }
  return total;
}

/** The longest prefix whose serialized cost is within `budget`, never cut inside a surrogate pair. */
export function cutToCost(s: string, budget: number): string {
  if (budget <= 0) return "";
  if (serializedCost(s) <= budget) return s;
  let i = 0;
  let used = 0;
  while (i < s.length) {
    const { cost, width } = unitAt(s, i);
    if (used + cost > budget) break;
    used += cost;
    i += width;
  }
  return s.slice(0, i);
}

/** Max-min fair (water-filling) split of `budget` over `costs`; the result keeps the input order. */
export function shareFairly(costs: readonly number[], budget: number): number[] {
  const alloc = costs.map(() => 0);
  const order = costs.map((_, i) => i).sort((a, b) => costs[a]! - costs[b]! || a - b);
  let remaining = Math.max(budget, 0);
  let left = costs.length;
  for (let n = 0; n < order.length; n++) {
    const i = order[n]!;
    const share = Math.floor(remaining / left);
    if (costs[i]! <= share) {
      alloc[i] = costs[i]!;
      remaining -= costs[i]!;
      left -= 1;
    } else {
      for (let m = n; m < order.length; m++) alloc[order[m]!] = share;
      break;
    }
  }
  return alloc;
}

function pointer(path: string): string[] {
  return path === "" ? [] : path.slice(1).split("/");
}

function isObject(value: unknown): value is Draft {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getAt(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const seg of pointer(path)) {
    if (Array.isArray(current)) current = current[Number(seg)];
    else if (isObject(current)) current = current[seg];
    else return undefined;
  }
  return current;
}

function assign(parent: Container, key: string | number, value: unknown): void {
  if (Array.isArray(parent)) parent[Number(key)] = value;
  else parent[String(key)] = value;
}

function setAt(root: Draft, path: string, value: unknown): void {
  const segs = pointer(path);
  const last = segs.pop();
  if (last === undefined) return;
  const parent = getAt(root, segs.length === 0 ? "" : "/" + segs.join("/"));
  if (Array.isArray(parent) || isObject(parent)) assign(parent, last, value);
}

/** Length of the finished text if `draft` were shipped with `cuts` recorded. */
function size(draft: Draft, cuts: readonly Cut[], ctx: Ctx): number {
  return JSON.stringify({
    ...draft,
    truncated: true,
    truncation: { limit: ctx.limit, originalLength: ctx.originalLength, cuts, advice: TRUNCATION_ADVICE },
  }).length;
}

/** Largest k in [0, n-1] for which `fits(k)` holds; 0 when none does. */
function largestFit(n: number, fits: (k: number) => boolean): number {
  let lo = 0;
  let hi = n - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function trimItems(draft: Draft, path: string, cuts: Cut[], ctx: Ctx): void {
  const arr = getAt(draft, path);
  if (!Array.isArray(arr) || arr.length === 0) return;
  const n = arr.length;
  const k = largestFit(n, (count) => {
    setAt(draft, path, arr.slice(0, count));
    return size(draft, [...cuts, { path, unit: "items", original: n, kept: count }], ctx) <= ctx.limit;
  });
  setAt(draft, path, arr.slice(0, k));
  cuts.push({ path, unit: "items", original: n, kept: k });
}

function trimText(draft: Draft, path: string, cuts: Cut[], ctx: Ctx): void {
  const s = getAt(draft, path);
  if (typeof s !== "string") return;
  const length = s.length;
  // Measured with kept = length, which has at least as many digits as the real value.
  setAt(draft, path, "");
  const base = size(draft, [...cuts, { path, unit: "chars", original: length, kept: length }], ctx);
  const t = cutToCost(s, ctx.limit - base);
  setAt(draft, path, t);
  cuts.push({ path, unit: "chars", original: length, kept: t.length });
}

function dropValue(draft: Draft, path: string, cuts: Cut[]): void {
  const v = getAt(draft, path);
  if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) return;
  const original = typeof v === "string" ? v.length : JSON.stringify(v).length;
  setAt(draft, path, null);
  cuts.push({ path, unit: "chars", original, kept: 0 });
}

function linkCount(docs: readonly Draft[], side: "internal" | "external"): number {
  let total = 0;
  for (const d of docs) {
    const links = d["links"];
    if (isObject(links) && Array.isArray(links[side])) total += links[side].length;
  }
  return total;
}

/** Empties every document's link lists. Returns true when the result then fits. */
function clearLinks(draft: Draft, docs: Draft[], path: string, cuts: Cut[], ctx: Ctx): boolean {
  const internal = linkCount(docs, "internal");
  const external = linkCount(docs, "external");
  if (internal + external === 0) return false;
  for (const d of docs) {
    if (isObject(d["links"])) d["links"] = { internal: [], external: [] };
  }
  if (internal > 0) cuts.push({ path: path + "/*/links/internal", unit: "items", original: internal, kept: 0 });
  if (external > 0) cuts.push({ path: path + "/*/links/external", unit: "items", original: external, kept: 0 });
  return size(draft, cuts, ctx) <= ctx.limit;
}

function trimDocuments(draft: Draft, path: string, cuts: Cut[], ctx: Ctx): void {
  const docs = getAt(draft, path);
  if (!Array.isArray(docs)) return;
  const n = docs.length;
  const items = docs as Draft[];
  if (clearLinks(draft, items, path, cuts, ctx)) return;

  const bodies = items.map((d) => (typeof d["markdown"] === "string" ? d["markdown"] : null));
  const withBody = (k: number): Set<number> => {
    const set = new Set<number>();
    for (let i = 0; i < k; i++) if (bodies[i] !== null && bodies[i] !== "") set.add(i);
    return set;
  };
  const skeletonSize = (k: number, shortened: ReadonlySet<number>): number => {
    setAt(draft, path, items.slice(0, k).map((d, i) => (bodies[i] === null ? d : { ...d, markdown: "" })));
    const extra: Cut[] = k < n ? [{ path, unit: "items", original: n, kept: k }] : [];
    for (const i of [...shortened].sort((a, b) => a - b)) {
      const length = bodies[i]!.length;
      extra.push({ path: path + "/" + i + "/markdown", unit: "chars", original: length, kept: length });
    }
    return size(draft, [...cuts, ...extra], ctx);
  };

  const k = skeletonSize(n, withBody(n)) <= ctx.limit
    ? n
    : largestFit(n, (count) => skeletonSize(count, withBody(count)) <= ctx.limit);

  const costs = bodies.slice(0, k).map((b) => (b === null ? 0 : serializedCost(b)));
  let known = new Set<number>();
  let alloc: number[];
  let cutSet: Set<number>;
  for (;;) {
    alloc = shareFairly(costs, ctx.limit - skeletonSize(k, known));
    cutSet = new Set(costs.map((_, i) => i).filter((i) => alloc[i]! < costs[i]!));
    if ([...cutSet].every((i) => known.has(i))) break;
    known = new Set([...known, ...cutSet]);
  }

  const shortened = new Map<number, string>();
  for (const i of cutSet) shortened.set(i, cutToCost(bodies[i]!, alloc[i]!));
  setAt(draft, path, items.slice(0, k).map((d, i) => (cutSet.has(i) ? { ...d, markdown: shortened.get(i) } : d)));
  if (k < n) cuts.push({ path, unit: "items", original: n, kept: k });
  for (const i of [...cutSet].sort((a, b) => a - b)) {
    cuts.push({ path: path + "/" + i + "/markdown", unit: "chars", original: bodies[i]!.length, kept: shortened.get(i)!.length });
  }
}

interface StringSlot {
  readonly parent: Container;
  readonly key: string | number;
  readonly value: string;
}

/** Every string value in the order JSON.stringify writes it; object keys are not included. */
function collectStrings(node: unknown, out: StringSlot[]): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => {
      if (typeof child === "string") out.push({ parent: node, key: i, value: child });
      else collectStrings(child, out);
    });
  } else if (isObject(node)) {
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (typeof child === "string") out.push({ parent: node, key, value: child });
      else collectStrings(child, out);
    }
  }
}

function lastResort(draft: Draft, cuts: Cut[], ctx: Ctx): void {
  const slots: StringSlot[] = [];
  collectStrings(draft, slots);
  const total = slots.reduce((sum, slot) => sum + slot.value.length, 0);
  for (const slot of slots) assign(slot.parent, slot.key, "");
  const base = size(draft, [...cuts, { path: "", unit: "chars", original: total, kept: total }], ctx);
  const budget = ctx.limit - base;
  if (budget < 0) {
    for (const slot of slots) assign(slot.parent, slot.key, slot.value);
    return;
  }
  const alloc = shareFairly(slots.map((slot) => serializedCost(slot.value)), budget);
  let kept = 0;
  slots.forEach((slot, j) => {
    const t = cutToCost(slot.value, alloc[j]!);
    assign(slot.parent, slot.key, t);
    kept += t.length;
  });
  cuts.push({ path: "", unit: "chars", original: total, kept });
}

function runStep(draft: Draft, step: TrimStep, cuts: Cut[], ctx: Ctx): void {
  switch (step.kind) {
    case "documents":
      trimDocuments(draft, step.path, cuts, ctx);
      break;
    case "text":
      trimText(draft, step.path, cuts, ctx);
      break;
    case "items":
      trimItems(draft, step.path, cuts, ctx);
      break;
    case "drop":
      dropValue(draft, step.path, cuts);
      break;
  }
}

/**
 * Fits `structured` under `limit` characters of JSON text, applying `steps` in
 * order until it fits. The input is never modified.
 */
export function fit(structured: Record<string, unknown>, steps: readonly TrimStep[], limit: number = CHARACTER_LIMIT): Fitted {
  const base = { ...structured, truncated: false, truncation: null };
  const text = JSON.stringify(base);
  if (text.length <= limit) return { value: base, text };

  const ctx: Ctx = { limit, originalLength: text.length };
  const draft = structuredClone(structured);
  const cuts: Cut[] = [];
  for (const step of steps) {
    if (size(draft, cuts, ctx) <= limit) break;
    runStep(draft, step, cuts, ctx);
  }
  if (size(draft, cuts, ctx) > limit) lastResort(draft, cuts, ctx);
  if (size(draft, cuts, ctx) > limit) throw new Error("fit: the result cannot be reduced under the size limit");

  const value = {
    ...draft,
    truncated: true,
    truncation: { limit, originalLength: ctx.originalLength, cuts, advice: TRUNCATION_ADVICE },
  };
  return { value, text: JSON.stringify(value) };
}
