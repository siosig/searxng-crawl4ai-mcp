import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEgress } from "../../src/security/egress.js";

const noExtras = { allow: [] as string[] };

test("refuses private, loopback, link-local, CGNAT and metadata literals", async () => {
  const blocked = [
    "http://127.0.0.1:8080/",
    "http://10.1.2.3/",
    "http://172.16.5.4/",
    "http://192.168.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    // An IPv4-mapped IPv6 literal must not sidestep the IPv4 rules.
    "http://[::ffff:192.168.1.1]/",
  ];

  for (const url of blocked) {
    const decision = await checkEgress(url, noExtras);
    assert.equal(decision.allowed, false, `${url} should be refused`);
    assert.equal(
      decision.failure?.kind,
      "egressDenied",
      `${url} must be reported as egressDenied, not ${decision.failure?.kind}`,
    );
  }
});

test("a refusal is distinguishable from an unreachable host", async () => {
  const denied = await checkEgress("http://192.168.0.1/", noExtras);
  const unreachable = await checkEgress(
    "http://this-name-does-not-resolve.invalid/",
    noExtras,
  );

  assert.equal(denied.failure?.kind, "egressDenied");
  assert.equal(unreachable.failure?.kind, "unreachable");
  assert.notEqual(denied.failure?.kind, unreachable.failure?.kind);
});

test("allows a public address", async () => {
  const decision = await checkEgress("http://93.184.215.14/", noExtras);
  assert.equal(decision.allowed, true, decision.failure?.message);
});

test("an operator can widen the policy but the denied set stays compiled in", async () => {
  const widened = await checkEgress("http://192.168.0.1/", {
    allow: ["192.168.0.0/24"],
  });
  assert.equal(widened.allowed, true, "an explicitly allowed range should pass");

  // A neighbouring private range is still refused: allowing one range must not
  // switch the whole policy off.
  const neighbour = await checkEgress("http://192.168.9.1/", {
    allow: ["192.168.0.0/24"],
  });
  assert.equal(neighbour.allowed, false);
  assert.equal(neighbour.failure?.kind, "egressDenied");
});

test("rejects non-http schemes and malformed input", async () => {
  for (const url of ["file:///etc/passwd", "gopher://example.com/"]) {
    const decision = await checkEgress(url, noExtras);
    assert.equal(decision.allowed, false);
    assert.equal(decision.failure?.kind, "egressDenied");
  }

  const bad = await checkEgress("not a url", noExtras);
  assert.equal(bad.allowed, false);
  assert.equal(bad.failure?.kind, "invalidInput");
});
