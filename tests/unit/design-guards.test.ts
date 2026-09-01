import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { buildServer, TOOL_NAMES } from "../../src/server.js";

/**
 * These are not tests of behaviour. They are the executable form of the design
 * rules that make this project able to follow upstream releases at all - the
 * ones a well-meaning change would otherwise erode quietly.
 */

// `.pathname` off a file URL is a URL path, not a filesystem one: on Windows
// it comes back as "/D:/...", and joining that produces "D:\D:\..." so every
// guard below fails to open the file it is about. The rest of the suite
// already converts properly - tests/unit/env.test.ts, tier-a/stdio.test.ts.
//
// Separators are then forced to "/" here and in walk(), because the guards
// exclude directories by writing them out - `!p.includes("/tests/")`, the
// same for "/upstream/". Against a backslash path those read as "exclude
// nothing", so on Windows the guards were reporting the test files that
// deliberately name the forbidden symbols, and the one directory allowed to
// speak HTTP, as violations of themselves. Node opens either form.
const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replaceAll("\\", "/");

function walk(dir: string, filter: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "dist", ".git", "tmp", "specs", ".specify"].includes(entry)) continue;
    const full = join(dir, entry).replaceAll("\\", "/");
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

test("both transports expose exactly the tools this server claims to have", async () => {
  // Two entries, one factory. The rule is that a transport decides who may
  // reach the tools, never which tools exist - so neither entry may assemble a
  // server of its own, and the list below is the only list.
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(serverSide);

  const replies: JSONRPCMessage[] = [];
  clientSide.onmessage = (message) => replies.push(message);
  await clientSide.start();
  await clientSide.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "design-guards", version: "1.0.0" },
    },
  });
  await clientSide.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await clientSide.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

  // The pair delivers on a microtask; the handler is async.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await server.close();

  const listed = replies.find(
    (message): message is JSONRPCMessage & { result: { tools: { name: string }[] } } =>
      "id" in message && message.id === 2 && "result" in message,
  );
  assert.ok(listed, "the built server did not answer tools/list");

  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name).sort(),
    [...TOOL_NAMES].sort(),
    "the advertised tools and TOOL_NAMES disagree; the contract tests are checking a stale list",
  );

  // And the entries hand that server over rather than building one. A tool
  // registered in an entry file would be reachable over one transport only,
  // which is the capability split this guard exists to prevent.
  for (const entry of ["src/transport/http.ts", "src/transport/stdio.ts"]) {
    const source = read(join(ROOT, entry));
    assert.match(source, /\(\) => buildServer\(\)/, `${entry} does not serve the shared factory`);
    assert.ok(
      !/register[A-Za-z]*Tool\s*\(/.test(source),
      `${entry} registers a tool of its own; only src/server.ts may decide the tool list`,
    );
  }
});

test("the contract stack builds the code under test, and cannot pull instead", () => {
  // This one is written from an actual failure rather than a worry. The test
  // overlay has always carried a `build:` section, but the base topology names
  // the published image from versions.env, and Compose's default pull policy
  // fetches a tag that exists in the registry rather than building. So the
  // gating contract tests exercised the last image that happened to be
  // published - and passed, because that image passes the tests that existed
  // when it was built. It only came apart when a change added tests for
  // behaviour the published image predates.
  //
  // Two things have to hold, and neither is enough alone.
  const overlay = read(join(ROOT, "docker/compose.test.yaml"));
  const versions = read(join(ROOT, "versions.env"));

  assert.match(
    overlay,
    /^\s*pull_policy:\s*build\s*$/m,
    "docker/compose.test.yaml must tell Compose to build the mcp image, not fetch one",
  );

  const published = /^MCP_IMAGE=(.+)$/m.exec(versions)?.[1]?.trim();
  assert.ok(published, "versions.env must name the published image");
  assert.ok(
    !overlay.includes(published),
    "the contract stack must not build under the published tag; doing so overwrites it locally, " +
      "and a later deploy of that tag stops being the thing that was released",
  );
});

test("the retry path never detaches its timers from the event loop", () => {
  // Written from two bugs with one shape. A backoff, and the extra wait a
  // `Retry-After` asks for, are both the middle of a request someone is
  // waiting on. Detached - `unref: true` on the p-retry options, `{ ref: false
  // }` on a timers/promises sleep - each is the only handle left whenever
  // nothing else is in flight, so the loop drains and the call is abandoned
  // partway through.
  //
  // It fails silently: nothing throws, the promise simply never settles. The
  // first version cost ten cancelled tests on CI while passing locally, and
  // the fix in one place left the identical mistake standing in the other.
  const retry = read(join(ROOT, "src/upstream/retry.ts"));

  for (const pattern of [/\bunref\s*:\s*true/, /\bref\s*:\s*false/, /\.unref\s*\(/]) {
    const offending = retry
      .split("\n")
      .filter((line) => pattern.test(line) && !line.trimStart().startsWith("//"));
    assert.deepEqual(
      offending,
      [],
      "a retry's waits must keep the process alive until the call it belongs to is done",
    );
  }
});

test("the SearXNG settings switch engines on and off, and define none of them", () => {
  // Written from a live failure rather than a worry. Upstream enables four
  // general web engines and ships google and bing off; on this deployment's
  // egress two of the four cannot answer at all - startpage returns a
  // country block, duckduckgo a bot challenge - so every search ran on
  // `google cse` alone while reporting three engines as unresponsive. Which
  // engines run therefore has to be stated here, because no environment
  // variable reaches it.
  //
  // Stating which is the whole of the licence. A definition copied into this
  // file - `engine:`, a `base_url:`, a category list - freezes upstream's
  // idea of how that engine is queried at the version it was copied from,
  // and quietly reintroduces exactly what `use_default_settings` is here to
  // prevent. The next release would keep fixing the engine while this
  // deployment kept querying it the old way.
  const settings = read(join(ROOT, "docker/searxng/settings.yml"));
  assert.match(
    settings,
    /^use_default_settings:\s*true\s*$/m,
    "the instance must keep inheriting upstream's engine definitions",
  );

  const section = /^engines:\s*$/m.exec(settings);
  assert.ok(section, "no engines section; the deployment is back on upstream's defaults");

  const body = settings
    .slice(section.index + section[0].length)
    .split("\n")
    .filter((line) => /^\s+\S/.test(line));
  assert.ok(body.length > 0, "the engines section is empty");

  const keys = body.flatMap((line) => /^\s*-?\s*([a-z_]+):/.exec(line)?.[1] ?? []);
  assert.deepEqual(
    [...new Set(keys)].filter((key) => key !== "name" && key !== "disabled").sort(),
    [],
    "only `name` and `disabled` belong here; any other key freezes an upstream engine definition",
  );
});
