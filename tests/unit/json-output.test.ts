import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { buildServer, TOOL_NAMES } from "../../src/server.js";
import { validateEnv } from "../../src/utils/env.js";

validateEnv({
  SEARXNG_URL: "http://searxng.test",
  CRAWL4AI_URL: "http://crawl4ai.test",
  CRAWL4AI_API_TOKEN: "c".repeat(16),
  MCP_AUTH_TOKEN: "t".repeat(32),
  MCP_ALLOWED_HOSTS: "localhost",
  RETRY_MAX_ATTEMPTS: "1",
});

/**
 * What these tests promise: the text of every tool reply is the serialisation
 * of its `structuredContent`, byte for byte, so a client that reads either one
 * sees the same document. There is no second rendering to choose between, which
 * is why a `format` argument no longer exists - a client that still sends one
 * gets the SDK's schema rejection instead of a silently ignored option.
 *
 * Every call goes through a linked in-memory transport, so the schemas, the
 * SDK's input validation and the reply envelope are the ones a real client
 * meets. Nothing leaves the process: the only URL used is 127.0.0.1, which the
 * egress policy refuses before any request is made.
 */

interface Session {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

async function open(): Promise<Session> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(serverSide);
  const waiting = new Map<number, (message: JSONRPCMessage) => void>();
  clientSide.onmessage = (message) => {
    if ("id" in message && typeof message.id === "number") waiting.get(message.id)?.(message);
  };
  await clientSide.start();
  let next = 1;
  const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} got no answer`)), 5_000);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        waiting.delete(id);
        if ("result" in message) resolve(message.result as Record<string, unknown>);
        else reject(new Error(JSON.stringify(message)));
      });
      void clientSide.send({ jsonrpc: "2.0", id, method, params });
    });
  };
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "json-output", version: "1.0.0" },
  });
  await clientSide.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { request, close: () => server.close() };
}

interface ToolReply {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function call(session: Session, name: string, args: Record<string, unknown>): Promise<ToolReply> {
  return (await session.request("tools/call", { name, arguments: args })) as unknown as ToolReply;
}

// The smallest valid arguments for each tool. Every URL is 127.0.0.1, which the
// egress policy denies, so no call that reaches a tool touches the network.
const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  web_search: { query: "x" },
  web_scrape: { url: "http://127.0.0.1/" },
  web_search_and_scrape: { query: "x" },
  web_batch_scrape: { urls: ["http://127.0.0.1/"] },
  web_crawl: { url: "http://127.0.0.1/" },
  web_map: { url: "http://127.0.0.1/" },
  web_extract: { url: "http://127.0.0.1/", instruction: "the title" },
};

test("the arguments table covers exactly the tools this server has", () => {
  assert.deepEqual(Object.keys(MINIMAL_ARGS).sort(), [...TOOL_NAMES].sort());
});

test("no tool advertises a format argument", async () => {
  const session = await open();
  try {
    const listed = (await session.request("tools/list", {})) as {
      tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[];
    };
    assert.equal(listed.tools.length, TOOL_NAMES.length);
    for (const tool of listed.tools) {
      assert.ok(
        !Object.keys(tool.inputSchema.properties ?? {}).includes("format"),
        `${tool.name} still advertises a format argument`,
      );
    }
  } finally {
    await session.close();
  }
});

test("a format argument is rejected as a schema violation, whatever its value", async () => {
  const session = await open();
  try {
    for (const name of TOOL_NAMES) {
      for (const format of ["markdown", "json"]) {
        const reply = await call(session, name, { ...MINIMAL_ARGS[name], format });
        const label = `${name} with format=${format}`;
        assert.equal(reply.isError, true, label);
        assert.ok(reply.content[0]!.text.startsWith("Input validation error:"), label);
        assert.equal(reply.structuredContent, undefined, label);
      }
    }
  } finally {
    await session.close();
  }
});

test("a failed single-URL call is an error whose text is its structuredContent", async () => {
  const session = await open();
  try {
    for (const name of ["web_scrape", "web_extract", "web_map", "web_crawl"]) {
      const reply = await call(session, name, MINIMAL_ARGS[name]!);
      const text = reply.content[0]!.text;
      const structured = reply.structuredContent as Record<string, unknown>;
      assert.equal(reply.isError, true, name);
      assert.ok(structured, `${name} returned no structuredContent`);
      assert.deepEqual(JSON.parse(text), structured, name);
      assert.equal(text, JSON.stringify(structured), name);
      assert.equal(structured["status"], "failed", name);
      assert.equal((structured["failure"] as { kind: string }).kind, "egressDenied", name);
      assert.equal(structured["truncated"], false, name);
      assert.equal(structured["truncation"], null, name);
    }
  } finally {
    await session.close();
  }
});

test("a batch with one denied URL succeeds and reports the failure per document", async () => {
  const session = await open();
  try {
    const reply = await call(session, "web_batch_scrape", MINIMAL_ARGS["web_batch_scrape"]!);
    const structured = reply.structuredContent as Record<string, unknown>;
    assert.equal(reply.isError, undefined);
    assert.ok(structured, "web_batch_scrape returned no structuredContent");
    assert.equal(reply.content[0]!.text, JSON.stringify(structured));
    assert.equal(structured["okCount"], 0);
    assert.equal(structured["failedCount"], 1);
    const documents = structured["documents"] as { failure: { kind: string } }[];
    assert.equal(documents[0]!.failure.kind, "egressDenied");
    assert.equal(structured["truncated"], false);
    assert.equal(structured["truncation"], null);
  } finally {
    await session.close();
  }
});
