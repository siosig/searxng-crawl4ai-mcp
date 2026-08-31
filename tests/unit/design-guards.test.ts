import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * These are not tests of behaviour. They are the executable form of the design
 * rules that make this project able to follow upstream releases at all - the
 * ones a well-meaning change would otherwise erode quietly.
 */

const ROOT = new URL("../../", import.meta.url).pathname;

function walk(dir: string, filter: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "dist", ".git", "tmp", "specs", ".specify"].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

const read = (p: string): string => readFileSync(p, "utf8");

test("upstream image versions are declared in versions.env and nowhere else", () => {
  const versions = read(join(ROOT, "versions.env"));
  assert.match(versions, /^SEARXNG_IMAGE=/m);
  assert.match(versions, /^CRAWL4AI_IMAGE=/m);

  // Any other file naming an upstream image would be a second place to edit,
  // which is exactly the failure this project exists to avoid.
  const offenders = walk(ROOT, (p) => /\.(ts|yaml|yml|json|env)$/.test(p) && !p.endsWith("versions.env"))
    .filter((p) => !p.includes("/tests/"))
    .filter((p) => /searxng\/searxng:|unclecode\/crawl4ai:/.test(read(p)));

  assert.deepEqual(offenders.map((p) => p.replace(ROOT, "")), []);
});

test("upstream images are pinned to immutable tags", () => {
  const versions = read(join(ROOT, "versions.env"));
  for (const line of versions.split("\n")) {
    const match = /^(SEARXNG_IMAGE|CRAWL4AI_IMAGE|NODE_IMAGE)=(.+)$/.exec(line.trim());
    if (!match) continue;
    const tag = match[2]!.split(":")[1] ?? "";
    assert.notEqual(tag, "", `${match[1]} has no tag`);
    assert.ok(
      !["latest", "main", "edge", "stable"].includes(tag),
      `${match[1]} uses the moving tag "${tag}"; a rebuild months from now would pull something else`,
    );
  }
});

test("no code calls the scraping library's internal API", () => {
  // The previous generation of this server embedded a wrapper around these,
  // which is why it could not follow upstream releases.
  const forbidden = ["AsyncWebCrawler", "CrawlerRunConfig", "LLMExtractionStrategy", "BFSDeepCrawlStrategy"];
  const offenders = walk(ROOT, (p) => /\.(ts|py|yaml|yml)$/.test(p))
    .filter((p) => !p.includes("/tests/"))
    .filter((p) => forbidden.some((name) => read(p).includes(name)));

  assert.deepEqual(offenders.map((p) => p.replace(ROOT, "")), []);
});

test("only src/upstream speaks HTTP to the upstream services", () => {
  const offenders = walk(join(ROOT, "src"), (p) => p.endsWith(".ts"))
    .filter((p) => !p.includes("/upstream/"))
    .filter((p) => /searxng:8080|crawl4ai:11235|\bfetch\(/.test(read(p)));

  assert.deepEqual(
    offenders.map((p) => p.replace(ROOT, "")),
    [],
    "an upstream contract change must stay a single-directory edit",
  );
});

test("the deployment builds nothing on the target host", () => {
  const compose = read(join(ROOT, "docker/compose.yaml"));
  assert.ok(!/^\s*build:/m.test(compose), "production compose must pull images, not build them");
});
