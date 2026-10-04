import { test } from "node:test";
import assert from "node:assert/strict";
import { clientFromEnv, FIXTURE } from "../client.js";

/**
 * A page that sends the request to a sign-in page is reported as
 * `loginRequired`, not as the sign-in page's content.
 *
 * The fixture's /session/members answers 302 to /account/signin, which
 * answers 200 with a password form - the shape a real site has when the saved
 * login is missing or has expired. This needs no login session store, so it
 * runs on the ordinary Tier A stack (specs/006-persistent-login-sessions).
 */

const client = clientFromEnv();
const MEMBERS = `${FIXTURE}/session/members`;

interface Failure {
  kind?: string;
  message?: string;
}

test("web_scrape reports a redirect to a sign-in page as loginRequired", async () => {
  const { structured, isError } = await client.call("web_scrape", { url: MEMBERS });
  const reason = structured.failure as Failure | null;

  assert.equal(isError, true, "a page behind a login must be announced as a failed call");
  assert.equal(structured.status, "failed");
  assert.equal(reason?.kind, "loginRequired", JSON.stringify(reason));
  assert.match(String(reason?.message), /\/account\/signin/, "the message must name the sign-in page");
  assert.doesNotMatch(
    String(reason?.message),
    /return_to/,
    "the sign-in page's query string must not leak into the message",
  );
});

test("web_batch_scrape reports loginRequired only for the URL behind a login", async () => {
  const urls = [MEMBERS, `${FIXTURE}/index.html`];
  const { structured } = await client.call("web_batch_scrape", { urls });

  const documents = structured.documents as { url: string; status: string; failure?: Failure | null }[];
  assert.equal(documents.length, 2);
  assert.deepEqual(documents.map((d) => d.url), urls, "results must stay in the order given");

  const [members, index] = documents;
  assert.equal(members!.status, "failed");
  assert.equal(members!.failure?.kind, "loginRequired", JSON.stringify(members!.failure));
  assert.equal(index!.status, "ok", JSON.stringify(index!.failure));
  assert.equal(structured.okCount, 1);
  assert.equal(structured.failedCount, 1, "one page behind a login must not fail the whole call");
});
