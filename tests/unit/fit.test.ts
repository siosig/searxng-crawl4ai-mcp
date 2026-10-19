import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fit,
  serializedCost,
  cutToCost,
  shareFairly,
  TRUNCATION_ADVICE,
  type Fitted,
  type Truncation,
  type TrimStep,
} from "../../src/utils/fit.js";

type Obj = Record<string, unknown>;

/** Every fitted result must fit the cap and the text must be exactly the value. */
function checked(r: Fitted, limit = 25_000): Fitted {
  assert.ok(r.text.length <= limit, `text is ${r.text.length} long, over ${limit}`);
  assert.deepEqual(JSON.parse(r.text), r.value);
  return r;
}

function truncation(r: Fitted): Truncation {
  return r.value["truncation"] as Truncation;
}

function documentsOf(r: Fitted): Obj[] {
  return r.value["documents"] as Obj[];
}

function doc(
  i: number,
  markdown: string | null,
  title: string | null = null,
  internal = 0,
  external = 0,
): Obj {
  return {
    url: "https://site.test/" + i,
    finalUrl: null,
    status: markdown === null ? "failed" : "ok",
    markdown,
    title,
    links: {
      internal: Array.from({ length: internal }, (_, j) => ({ href: "https://site.test/p/" + j, text: "" })),
      external: Array.from({ length: external }, (_, j) => ({ href: "https://other.test/p/" + j, text: "" })),
    },
    failure: null,
  };
}

function withoutLinks(d: Obj): Obj {
  return { ...d, links: null };
}

const TEXT_STEP: TrimStep[] = [{ kind: "text", path: "/markdown" }];
const DOCUMENTS_STEP: TrimStep[] = [{ kind: "documents", path: "/documents" }];

test("serializedCost equals the JSON-escaped length of the string body", () => {
  const samples = ["", "abc", 'a"b\\c', "\n\t\r\b\f", "\u0000\u001f", "😀", "\ud800", "\udc00", "a\ud800b", "\u65e5\u672c\u8a9e"];
  for (const s of samples) {
    assert.equal(serializedCost(s), JSON.stringify(s).length - 2, JSON.stringify(s));
  }
});

test("cutToCost returns the longest prefix whose serialized cost fits the budget", () => {
  assert.equal(cutToCost("abcdef", 3), "abc");
  assert.equal(cutToCost("abc", 0), "");
  assert.equal(cutToCost("abc", -5), "");
  assert.equal(cutToCost("abc", 10), "abc");
  assert.equal(cutToCost("a😀b", 2), "a");
  assert.equal(cutToCost("a😀b", 3), "a😀");
  assert.equal(cutToCost('ab"c', 3), "ab");

  const s = 'x"\n😀\u0001y'.repeat(50);
  for (let budget = 0; budget <= 120; budget++) {
    const t = cutToCost(s, budget);
    assert.ok(s.startsWith(t), `budget ${budget}: result is not a prefix`);
    assert.ok(serializedCost(t) <= budget, `budget ${budget}: result is over budget`);
    if (t !== s) {
      const width = (s.codePointAt(t.length) ?? 0) > 0xffff ? 2 : 1;
      const next = s.slice(t.length, t.length + width);
      assert.ok(serializedCost(t) + serializedCost(next) > budget, `budget ${budget}: result is not maximal`);
    }
  }
});

test("shareFairly gives small demands in full and splits the rest evenly", () => {
  assert.deepEqual(shareFairly([10, 100, 1000], 300), [10, 100, 190]);
  assert.deepEqual(shareFairly([500, 500, 500], 1000), [333, 333, 333]);
  assert.deepEqual(shareFairly([], 50), []);
  assert.deepEqual(shareFairly([0, 5, 5000], 100), [0, 5, 95]);
  assert.deepEqual(shareFairly([3, 4], -10), [0, 0]);
  assert.deepEqual(shareFairly([3, 4], 100), [3, 4]);
});

test("shareFairly keeps allocations within demand and budget, and cut shares equal", () => {
  let seed = 12345;
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let round = 0; round < 200; round++) {
    const length = 1 + next(8);
    const costs = Array.from({ length }, () => next(1001));
    const budget = next(3001);
    const alloc = shareFairly(costs, budget);
    assert.equal(alloc.length, costs.length);
    let total = 0;
    const cutShares = new Set<number>();
    let largestFull = 0;
    for (let i = 0; i < costs.length; i++) {
      assert.ok(alloc[i]! >= 0 && alloc[i]! <= costs[i]!, `round ${round}: alloc[${i}] out of range`);
      total += alloc[i]!;
      if (alloc[i]! < costs[i]!) cutShares.add(alloc[i]!);
      else largestFull = Math.max(largestFull, costs[i]!);
    }
    assert.ok(total <= budget, `round ${round}: allocated ${total} of ${budget}`);
    assert.ok(cutShares.size <= 1, `round ${round}: cut shares differ`);
    for (const share of cutShares) {
      assert.ok(share >= largestFull, `round ${round}: a cut share is below a full one`);
    }
  }
});

test("a result within the limit is returned as is, with truncated false", () => {
  const s = { a: 1, b: "x" };
  const r = checked(fit(s, []));
  assert.deepEqual(r.value, { a: 1, b: "x", truncated: false, truncation: null });
  assert.deepEqual(Object.keys(r.value).slice(-2), ["truncated", "truncation"]);
  assert.equal(r.text, JSON.stringify(r.value));
  assert.deepEqual(s, { a: 1, b: "x" });
});

test("the text step shortens a string so the text is exactly the limit", () => {
  const s = { url: "u", markdown: "x".repeat(60_000) };
  const r = checked(fit(s, TEXT_STEP));
  assert.equal(r.text.length, 25_000);
  assert.equal(r.value["truncated"], true);
  assert.deepEqual(r.value["truncation"], {
    limit: 25_000,
    originalLength: JSON.stringify({ ...s, truncated: false, truncation: null }).length,
    cuts: [{ path: "/markdown", unit: "chars", original: 60_000, kept: (r.value["markdown"] as string).length }],
    advice: TRUNCATION_ADVICE,
  });
  assert.equal(s.markdown.length, 60_000);
});

test("a string full of escapes is cut by its serialized cost", () => {
  const s = { markdown: 'a"\n'.repeat(20_000) };
  const r = checked(fit(s, TEXT_STEP));
  assert.ok(r.text.length <= 25_000);
  assert.ok(r.text.length >= 24_998);
  assert.ok(s.markdown.startsWith(r.value["markdown"] as string));
});

test("a string of surrogate pairs is never cut inside a pair", () => {
  const s = { markdown: "😀".repeat(30_000) };
  const r = checked(fit(s, TEXT_STEP));
  const kept = r.value["markdown"] as string;
  assert.equal(kept.length % 2, 0);
  assert.equal(/[\ud800-\udbff]$/.test(kept), false);
});

test("the items step keeps the most elements that still fit", () => {
  const results = Array.from({ length: 100 }, (_, i) => String(i).padEnd(500, "r"));
  const s = { results };
  const r = checked(fit(s, [{ kind: "items", path: "/results" }]));
  const kept = (r.value["results"] as string[]).length;
  assert.ok(kept > 0 && kept < 100);
  assert.deepEqual(truncation(r).cuts, [{ path: "/results", unit: "items", original: 100, kept }]);
  assert.deepEqual(r.value["results"], results.slice(0, kept));

  const oneMore = {
    results: results.slice(0, kept + 1),
    truncated: true,
    truncation: {
      ...truncation(r),
      cuts: [{ path: "/results", unit: "items", original: 100, kept: kept + 1 }],
    },
  };
  assert.ok(JSON.stringify(oneMore).length > 25_000);
});

test("the items step follows a nested path", () => {
  const results = Array.from({ length: 100 }, (_, i) => String(i).padEnd(500, "r"));
  const r = checked(fit({ search: { query: "q", results } }, [{ kind: "items", path: "/search/results" }]));
  assert.equal(truncation(r).cuts[0]?.path, "/search/results");
  assert.equal((r.value["search"] as Obj)["query"], "q");
});

test("the drop step nulls a value that the earlier steps could not shrink", () => {
  const steps: TrimStep[] = [
    { kind: "items", path: "/data" },
    { kind: "drop", path: "/data" },
  ];

  const a = { data: "d".repeat(60_000) };
  const ra = checked(fit(a, steps));
  assert.equal(ra.value["data"], null);
  assert.deepEqual(truncation(ra).cuts, [{ path: "/data", unit: "chars", original: 60_000, kept: 0 }]);

  const b = { data: { blob: "d".repeat(60_000) } };
  const rb = checked(fit(b, steps));
  assert.deepEqual(truncation(rb).cuts, [
    { path: "/data", unit: "chars", original: JSON.stringify(b.data).length, kept: 0 },
  ]);

  const c = { data: ["a", "b", "c"].map((ch) => ch.repeat(30_000)) };
  const rc = checked(fit(c, steps));
  assert.deepEqual(rc.value["data"], []);
  assert.deepEqual(truncation(rc).cuts, [{ path: "/data", unit: "items", original: 3, kept: 0 }]);
});

test("the documents step first empties the link lists, and stops if that is enough", () => {
  const s = { documents: [doc(0, "short", null, 1_500), doc(1, "also short", null, 1_500)] };
  const r = checked(fit(s, DOCUMENTS_STEP));
  assert.deepEqual(truncation(r).cuts, [
    { path: "/documents/*/links/internal", unit: "items", original: 3_000, kept: 0 },
  ]);
  const docs = documentsOf(r);
  assert.deepEqual(docs[0]?.["links"], { internal: [], external: [] });
  assert.deepEqual(docs[1]?.["links"], { internal: [], external: [] });
  assert.equal(docs[0]?.["markdown"], "short");
  assert.equal(docs[1]?.["markdown"], "also short");
});

test("the documents step shares the body budget fairly between documents", () => {
  const s = {
    documents: [
      withoutLinks(doc(0, "a".repeat(1_000))),
      withoutLinks(doc(1, "b".repeat(40_000))),
      withoutLinks(doc(2, "c".repeat(40_000))),
    ],
  };
  const r = checked(fit(s, DOCUMENTS_STEP));
  const cuts = truncation(r).cuts;
  assert.deepEqual(cuts.map((c) => c.path), ["/documents/1/markdown", "/documents/2/markdown"]);
  const docs = documentsOf(r);
  assert.equal(docs[0]?.["markdown"], "a".repeat(1_000));
  assert.equal(docs.length, 3);
  assert.ok(Math.abs(cuts[0]!.kept - cuts[1]!.kept) <= 1);
  assert.equal(cuts[0]!.kept, (docs[1]?.["markdown"] as string).length);
  assert.equal(cuts[1]!.kept, (docs[2]?.["markdown"] as string).length);
  assert.equal(cuts[0]!.original, 40_000);
  assert.equal(cuts[1]!.original, 40_000);
});

test("a document without a body is not cut", () => {
  const s = { documents: [withoutLinks(doc(0, null)), withoutLinks(doc(1, "b".repeat(60_000)))] };
  const r = checked(fit(s, DOCUMENTS_STEP));
  assert.deepEqual(truncation(r).cuts.map((c) => c.path), ["/documents/1/markdown"]);
  assert.equal(documentsOf(r)[0]?.["markdown"], null);
});

test("the documents step drops trailing documents when even empty bodies do not fit", () => {
  const documents = Array.from({ length: 30 }, (_, i) => withoutLinks(doc(i, "", "t".repeat(1_500))));
  const r = checked(fit({ documents }, DOCUMENTS_STEP));
  const kept = documentsOf(r).length;
  assert.ok(kept > 0 && kept < 30);
  assert.deepEqual(truncation(r).cuts, [{ path: "/documents", unit: "items", original: 30, kept }]);
  assert.ok(25_000 - r.text.length < JSON.stringify(documentsOf(r)[0]).length + 1);
});

test("the documents step drops trailing documents, then shares the rest fairly", () => {
  const documents = Array.from({ length: 30 }, (_, i) =>
    withoutLinks(doc(i, "m".repeat(5_000), "t".repeat(1_000))),
  );
  const r = checked(fit({ documents }, DOCUMENTS_STEP));
  const cuts = truncation(r).cuts;
  const first = cuts[0]!;
  assert.equal(first.path, "/documents");
  assert.equal(first.unit, "items");
  assert.equal(first.original, 30);
  assert.ok(first.kept > 0 && first.kept < 30);
  assert.deepEqual(
    cuts.slice(1).map((c) => c.path),
    Array.from({ length: first.kept }, (_, i) => "/documents/" + i + "/markdown"),
  );
  const kepts = cuts.slice(1).map((c) => c.kept);
  assert.ok(Math.max(...kepts) - Math.min(...kepts) <= 1);
});

test("with no steps, the last resort shortens the strings of the whole result", () => {
  const s = { title: "t".repeat(60_000) };
  const r = checked(fit(s, []));
  assert.deepEqual(truncation(r).cuts, [
    { path: "", unit: "chars", original: 60_000, kept: (r.value["title"] as string).length },
  ]);
});

test("the last resort keeps a failure's structure and cuts only its strings", () => {
  const s = {
    status: "failed",
    failure: { kind: "upstreamUnavailable", message: "m".repeat(60_000), upstreamStatus: null },
  };
  const r = checked(fit(s, []));
  const f = r.value["failure"] as Obj;
  assert.equal(r.value["status"], "failed");
  assert.equal(f["kind"], "upstreamUnavailable");
  assert.equal(f["upstreamStatus"], null);
  assert.deepEqual(truncation(r).cuts, [
    { path: "", unit: "chars", original: 6 + 19 + 60_000, kept: 6 + 19 + (f["message"] as string).length },
  ]);
});

test("a result that cannot be reduced under the limit throws", () => {
  assert.throws(() => fit({ a: 1 }, [], 10), /cannot be reduced under the size limit/);
});
