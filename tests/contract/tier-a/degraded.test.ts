import { test } from "node:test";
import assert from "node:assert/strict";
import { clientFromEnv, FIXTURE } from "../client.js";

/**
 * The stack must stand up without a language-model credential.
 *
 * Run with DEGRADED_RUN=1 against a stack started without GEMINI_API_KEY.
 * Skipped otherwise, because the assertion is about the absence of a key.
 */

const client = clientFromEnv();
const degradedRun = process.env.DEGRADED_RUN === "1";

test(
  "web_extract returns page content instead of failing when no model is configured",
  { skip: degradedRun ? false : "set DEGRADED_RUN=1 on a stack started without GEMINI_API_KEY" },
  async () => {
    const { structured } = await client.call("web_extract", {
      url: `${FIXTURE}/product.html`,
      instruction: "the price",
    });

    assert.equal(structured.degraded, true, "extraction should degrade, not fail");
    assert.equal(structured.failure, null);
    assert.match(String(structured.markdown), /Widget/, "the page content must still come back");
  },
);

test(
  "every other tool works with no model credentials at all",
  { skip: degradedRun ? false : "set DEGRADED_RUN=1 on a stack started without GEMINI_API_KEY" },
  async () => {
    const scrape = await client.call("web_scrape", { url: `${FIXTURE}/index.html` });
    assert.equal(scrape.structured.status, "ok");

    const map = await client.call("web_map", { url: `${FIXTURE}/index.html` });
    assert.ok((map.structured.internal as string[]).length > 0);

    const crawl = await client.call("web_crawl", { url: `${FIXTURE}/index.html`, maxDepth: 1, maxPages: 3 });
    assert.ok((crawl.structured.pagesFetched as number) >= 1);
  },
);
