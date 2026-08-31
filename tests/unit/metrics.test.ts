import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundedLabelSet, engineFailureReason } from "../../src/metrics/normalize.js";
import {
  disableMetrics,
  enableMetrics,
  metricsEnabled,
  recordConcurrencyRejection,
  recordDocuments,
  recordSearch,
  recordSlots,
  recordToolCall,
  recordUpstream,
} from "../../src/metrics/record.js";
import { registry } from "../../src/metrics/registry.js";

/**
 * These are the tests that make "metrics never break the server" a fact rather
 * than an intention.
 */

test("an upstream reason string is folded into a set we control", () => {
  // Both of these were observed from a live metasearch instance.
  assert.equal(engineFailureReason("CAPTCHA"), "captcha");
  assert.equal(
    engineFailureReason("Suspended: CAPTCHA"),
    "captcha",
    "the CAPTCHA is the cause; the suspension is its consequence",
  );

  assert.equal(engineFailureReason("Suspended: too many requests"), "suspended");
  assert.equal(engineFailureReason("timeout"), "timeout");
  assert.equal(engineFailureReason("Request timed out"), "timeout");
  assert.equal(engineFailureReason("SearxEngineException"), "error");
  assert.equal(engineFailureReason("something else entirely"), "other");
});

test("distinct label values are capped so an upstream cannot grow them without limit", () => {
  const set = new BoundedLabelSet(3);
  assert.equal(set.resolve("google"), "google");
  assert.equal(set.resolve("bing"), "bing");
  assert.equal(set.resolve("brave"), "brave");

  // Past the cap everything collapses rather than adding series.
  assert.equal(set.resolve("mojeek"), "other");
  assert.equal(set.resolve("startpage"), "other");

  // Names already seen keep working.
  assert.equal(set.resolve("google"), "google");
  assert.equal(set.size, 3);
});

test("empty and blank names never become a label", () => {
  const set = new BoundedLabelSet(10);
  assert.equal(set.resolve(""), "other");
  assert.equal(set.resolve("   "), "other");
  assert.equal(set.size, 0);
});

test("recording is a no-op while metrics are disabled", async () => {
  disableMetrics();
  assert.equal(metricsEnabled(), false);

  recordToolCall("web_scrape", "success", 1.5, null);
  recordSearch(0, [{ engine: "google", reason: "CAPTCHA" }]);
  recordDocuments(["ok", "failed"]);
  recordUpstream("crawl4ai", "markdown", "success", 0.5);
  recordSlots(2, 4);
  recordConcurrencyRejection();

  const text = await registry.metrics();
  // Counters that were never touched are simply absent from the output.
  assert.ok(
    !text.includes("mcp_tool_calls_total{"),
    "nothing should have been recorded while disabled",
  );
});

test("recording never throws, whatever it is handed", () => {
  enableMetrics();

  // Values a caller should not pass, passed anyway. None of these may escape
  // as an exception, because an exception here would fail a tool call.
  assert.doesNotThrow(() => recordToolCall("web_scrape", "success", Number.NaN, null));
  assert.doesNotThrow(() => recordToolCall("", "failure", -1, "unreachable"));
  assert.doesNotThrow(() => recordSearch(-5, [{ engine: "", reason: "" }]));
  assert.doesNotThrow(() => recordDocuments([]));
  assert.doesNotThrow(() => recordUpstream("crawl4ai", "markdown", "success", Number.POSITIVE_INFINITY));
  assert.doesNotThrow(() => recordSlots(Number.NaN, Number.NaN));

  disableMetrics();
});

test("a broken registry does not surface as an exception", () => {
  enableMetrics();

  const original = Object.getOwnPropertyDescriptor(registry, "getSingleMetric");
  // Simulate the registry misbehaving from underneath us.
  Object.defineProperty(registry, "getSingleMetric", {
    value: () => {
      throw new Error("registry is broken");
    },
    configurable: true,
  });

  assert.doesNotThrow(() => recordToolCall("web_scrape", "success", 1, null));

  if (original) Object.defineProperty(registry, "getSingleMetric", original);
  disableMetrics();
});

test("what is recorded while enabled actually lands", async () => {
  enableMetrics();
  recordToolCall("web_scrape", "failure", 2, "egressDenied");
  recordDocuments(["ok", "ok", "failed"]);

  const text = await registry.metrics();
  assert.match(text, /mcp_tool_calls_total\{tool="web_scrape",result="failure"\}/);
  assert.match(text, /mcp_tool_failures_total\{tool="web_scrape",kind="egressDenied"\}/);
  assert.match(text, /mcp_documents_total\{result="ok"\}/);

  disableMetrics();
});
