/**
 * A minimal MCP client for the contract tests.
 *
 * The point of these tests is that the real upstream containers are running and
 * answering, so nothing here is mocked: this speaks the wire protocol to a live
 * server over HTTP.
 */

const PROTOCOL = "2026-07-28";

const META = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL,
  "io.modelcontextprotocol/clientInfo": { name: "contract-tests", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

export interface ToolResult {
  readonly text: string;
  readonly structured: Record<string, unknown>;
  /**
   * Whether the call reported itself as failed.
   *
   * Absent means the protocol read the call as successful, so this is
   * what has to be checked to know a failure was actually announced as
   * one rather than merely described in the text.
   */
  readonly isError: boolean | undefined;
}

export class McpClient {
  #id = 0;

  constructor(
    private readonly endpoint: string,
    private readonly token: string,
  ) {}

  async #rpc(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL,
      // The 2026-07-28 revision requires the method - and, for a tool call, the
      // tool name - to be restated in headers so a proxy can route without
      // parsing the body.
      "Mcp-Method": method,
    };
    if (typeof params.name === "string") headers["Mcp-Name"] = params.name;

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.#id,
        method,
        params: { ...params, _meta: META },
      }),
    });

    const body = await response.text();
    const payload = body.startsWith("event:")
      ? (body.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? "{}")
      : body;
    return JSON.parse(payload) as Record<string, unknown>;
  }

  async listTools(): Promise<string[]> {
    const res = await this.#rpc("tools/list");
    const result = res.result as { tools?: { name: string }[] } | undefined;
    return (result?.tools ?? []).map((t) => t.name);
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const res = await this.#rpc("tools/call", { name, arguments: args });
    if (res.error) {
      throw new Error(`${name} failed at the protocol level: ${JSON.stringify(res.error)}`);
    }
    const result = res.result as {
      content?: { text?: string }[];
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    return {
      text: result.content?.[0]?.text ?? "",
      structured: result.structuredContent ?? {},
      isError: result.isError,
    };
  }

  /** Raw fetch, for checks about the transport rather than a tool. */
  async raw(headers: Record<string, string>): Promise<Response> {
    return fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} }),
    });
  }
}

export function clientFromEnv(): McpClient {
  const endpoint = process.env.MCP_ENDPOINT ?? "http://127.0.0.1:3003/mcp";
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) throw new Error("MCP_AUTH_TOKEN must be set to run the contract tests");
  return new McpClient(endpoint, token);
}

/** The fixture origin, as seen from inside the compose network. */
export const FIXTURE = process.env.FIXTURE_ORIGIN ?? "http://fixture-site";
