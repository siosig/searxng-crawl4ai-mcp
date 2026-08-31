import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { connect, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { TOOL_NAMES } from "../../../src/server.js";

/**
 * The stdio entry, exercised the way a client exercises it: as a child process
 * spoken to over its pipes.
 *
 * Nothing here is given a bearer token or a host allow-list, and that absence
 * is the test. It also means these cases say nothing about the HTTP entry's
 * defences - security.test.ts owns those, and the two files must keep
 * disagreeing about what is required.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The entry point, run through the same loader the rest of this suite uses.
 *
 * Deliberately not dist/index.js. A checkout that has been built once and
 * edited since would run this suite against the old artifact and pass, which
 * is the exact failure a contract test must not have; and the tier-A job never
 * builds, so preferring dist would only ever mean "whatever is lying around".
 * The transport code being exercised is the same either way.
 */
const command = ["--import", "tsx", join(ROOT, "src/index.ts")];

/**
 * The environment a stdio client would provide.
 *
 * Built from scratch rather than inherited: the tier-A job exports the HTTP
 * stack's credentials, and inheriting them would let this suite pass while the
 * stdio entry quietly still demanded them.
 */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    MCP_TRANSPORT: "stdio",
    SEARXNG_URL: process.env.SEARXNG_PROBE_URL ?? "http://127.0.0.1:8081",
    CRAWL4AI_URL: process.env.CRAWL4AI_PROBE_URL ?? "http://127.0.0.1:11235",
    // Only needs to satisfy the schema. Every assertion below is decided before
    // an upstream is called, so the value is never presented to anything.
    CRAWL4AI_API_TOKEN: process.env.CRAWL4AI_API_TOKEN ?? "tier-a-stdio-placeholder-token",
    // The noisiest setting, on purpose: a diagnostic line that leaks onto the
    // protocol channel has to be given every chance to appear.
    LOG_LEVEL: "debug",
    ...extra,
  };
}

interface Reply {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: unknown;
}

/** A running stdio server, plus everything it has written to either stream. */
class Session {
  #id = 0;
  #stdout = "";
  #stderr = "";
  readonly lines: string[] = [];
  readonly replies = new Map<number, Reply>();

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.#stdout += chunk;
      // Frames are newline-delimited; hold back the trailing partial one.
      const parts = this.#stdout.split("\n");
      this.#stdout = parts.pop() ?? "";
      for (const line of parts) {
        this.lines.push(line);
        const parsed: unknown = ((): unknown => {
          try {
            return JSON.parse(line);
          } catch {
            return undefined;
          }
        })();
        if (parsed !== null && typeof parsed === "object") {
          const reply = parsed as Reply;
          if (typeof reply.id === "number") this.replies.set(reply.id, reply);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
  }

  static start(env: Record<string, string> = childEnv()): Session {
    return new Session(
      spawn(process.execPath, command, { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] }),
    );
  }

  get stderr(): string {
    return this.#stderr;
  }

  #send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Send a request and wait for the reply carrying its id. */
  async rpc(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
    const id = ++this.#id;
    this.#send({ jsonrpc: "2.0", id, method, params });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const reply = this.replies.get(id);
      if (reply) return reply;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`no reply to ${method} within 20s; stderr was:\n${this.#stderr}`);
  }

  async initialize(): Promise<Reply> {
    const reply = await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "contract-tests", version: "1.0.0" },
    });
    this.#send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return reply;
  }

  stop(): void {
    this.child.kill("SIGTERM");
  }
}

const sessions: Session[] = [];
function session(env?: Record<string, string>): Session {
  const started = env === undefined ? Session.start() : Session.start(env);
  sessions.push(started);
  return started;
}

after(() => {
  for (const open of sessions) open.stop();
});

test("the server starts and serves with no credentials of its own", async () => {
  const server = session();

  const initialized = await server.initialize();
  assert.ok(
    initialized.result,
    `initialize failed on a server started without MCP_AUTH_TOKEN or MCP_ALLOWED_HOSTS: ${server.stderr}`,
  );

  const listed = await server.rpc("tools/list");
  const tools = (listed.result as { tools?: { name: string }[] } | undefined)?.tools ?? [];
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [...TOOL_NAMES].sort(),
    "the stdio entry advertises a different set of tools than the HTTP entry",
  );
});

test("nothing but JSON-RPC is written to the protocol channel", async () => {
  const server = session();
  await server.initialize();
  await server.rpc("tools/list");
  // A call that fails, because a failure is when a diagnostic is most tempting.
  await server.rpc("tools/call", {
    name: "web_scrape",
    arguments: { url: "http://10.255.255.1/" },
  });
  // An unknown method, so the SDK's own error path is exercised too.
  await server.rpc("nothing/here");

  for (const line of server.lines) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      assert.fail(`a non-JSON line reached stdout and corrupted the session: ${line.slice(0, 200)}`);
    }
    assert.equal(
      (parsed as { jsonrpc?: string }).jsonrpc,
      "2.0",
      `stdout carried JSON that is not a protocol frame: ${line.slice(0, 200)}`,
    );
  }

  // The diagnostics still exist - they are simply on the other stream. Without
  // this the test above would also pass on a server that logs nothing at all.
  assert.notEqual(server.stderr, "", "no diagnostics reached stderr; logging is not being exercised");
});

test("the outbound policy is the same one the HTTP entry enforces", async () => {
  const server = session();
  await server.initialize();

  for (const url of ["http://127.0.0.1:8080/", "http://169.254.169.254/latest/meta-data/", "http://10.255.255.1/"]) {
    const reply = await server.rpc("tools/call", { name: "web_scrape", arguments: { url } });
    const structured = (reply.result as { structuredContent?: Record<string, unknown> } | undefined)
      ?.structuredContent;
    const failure = structured?.failure as { kind?: string } | null | undefined;

    assert.ok(failure, `${url} was not refused over stdio`);
    assert.equal(
      failure.kind,
      "egressDenied",
      `${url} must be refused as policy over stdio too, not reported as ${String(failure.kind)}`,
    );
  }
});

/** A port nothing is listening on right now, and probably will not be. */
async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address !== null && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.setTimeout(1_000);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const no = (): void => {
      socket.destroy();
      resolve(false);
    };
    socket.on("error", no);
    socket.on("timeout", no);
  });
}

test("two stdio servers run side by side even with METRICS_PORT set", async () => {
  // A client starts one of these per session, and a machine runs several
  // clients. If the stdio entry claimed a fixed port, the second client would
  // be the one that breaks - and it would break at startup, before anyone
  // could see why.
  const port = await unusedPort();
  const env = childEnv({ METRICS_PORT: String(port), METRICS_HOST: "127.0.0.1" });

  const first = session(env);
  const second = session(env);

  for (const server of [first, second]) {
    const initialized = await server.initialize();
    assert.ok(initialized.result, `a second stdio server failed to start: ${server.stderr}`);
  }

  assert.equal(
    await isListening(port),
    false,
    `METRICS_PORT was opened by a stdio server; the next client on this machine cannot start`,
  );
});
