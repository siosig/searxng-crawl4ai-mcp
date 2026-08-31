import { test } from "node:test";
import assert from "node:assert/strict";
import { clientFromEnv, FIXTURE } from "../client.js";

const client = clientFromEnv();

test("an unauthenticated call reaches no tool", async () => {
  const res = await client.raw({});
  assert.equal(res.status, 401);
});

test("a wrong token reaches no tool", async () => {
  const res = await client.raw({ authorization: "Bearer not-the-token" });
  assert.equal(res.status, 401);
});

test("a host outside the allow-list is refused", async () => {
  const res = await client.raw({
    authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}`,
    host: "attacker.example.net",
  });
  assert.notEqual(res.status, 200, "DNS-rebinding protection is not in effect");
});

test("private and metadata addresses are refused, and say so", async () => {
  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8080/",
    "http://10.255.255.1/",
    "http://192.168.77.1/",
  ]) {
    const { structured } = await client.call("web_scrape", { url });
    const failure = structured.failure as { kind: string } | null;
    assert.ok(failure, `${url} was not refused`);
    assert.equal(
      failure.kind,
      "egressDenied",
      `${url} must be refused as policy, not reported as ${failure.kind}`,
    );
  }
});

test("an allowed range is reachable, so the allow-list actually widens the policy", async () => {
  // The fixture origin is on a private compose network; it is only reachable
  // because SCRAPE_ALLOW_CIDRS lists that range.
  const { structured } = await client.call("web_scrape", { url: `${FIXTURE}/index.html` });
  assert.equal(structured.status, "ok", "the configured allow-list is not being honoured");
});

test("a refusal is distinguishable from an unreachable host", async () => {
  const denied = await client.call("web_scrape", { url: "http://10.255.255.1/" });
  const unreachable = await client.call("web_scrape", {
    url: "http://nothing-resolves-here.invalid/",
  });

  const a = (denied.structured.failure as { kind: string }).kind;
  const b = (unreachable.structured.failure as { kind: string }).kind;
  assert.equal(a, "egressDenied");
  assert.equal(b, "unreachable");
});
