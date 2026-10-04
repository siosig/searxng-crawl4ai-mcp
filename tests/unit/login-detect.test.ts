import { test } from "node:test";
import assert from "node:assert/strict";
import { describeLoginPage, isLoginRedirect } from "../../src/upstream/login-detect.js";

/**
 * Telling a sign-in redirect from an ordinary answer by the shape of the URL.
 *
 * The rows are the truth table of contracts/mcp-behaviour.md §4, copied as is;
 * the Amazon and Rakuten addresses are the redirects those sites really send.
 */

const TRUTH_TABLE: ReadonlyArray<{
  requested: string;
  finalUrl: string | null;
  expected: boolean;
  why: string;
}> = [
  {
    requested: "https://www.amazon.co.jp/gp/css/order-history",
    finalUrl: "https://www.amazon.co.jp/ap/signin?openid.return_to=x",
    expected: true,
    why: "a signin path segment",
  },
  {
    requested: "https://my.rakuten.co.jp/",
    finalUrl: "https://login.account.rakuten.com/sso/authorize?client_id=x",
    expected: true,
    why: "a login host label",
  },
  {
    requested: "https://point.rakuten.co.jp/",
    finalUrl: "https://grp01.id.rakuten.co.jp/rms/nid/vc?__event=login&service_id=x",
    expected: true,
    why: "a query value of login",
  },
  {
    requested: "http://fixture-site/session/members",
    finalUrl: "http://fixture-site/account/signin?return_to=%2Fsession%2Fmembers",
    expected: true,
    why: "a signin segment on the same host",
  },
  {
    requested: "https://example.com/a",
    finalUrl: null,
    expected: false,
    why: "no final URL",
  },
  {
    requested: "https://example.com/a",
    finalUrl: "https://example.com/a",
    expected: false,
    why: "no redirect at all",
  },
  {
    requested: "https://example.com/a",
    finalUrl: "https://example.com/blog/how-to-login-faster",
    expected: false,
    why: "segments match whole, not in part",
  },
  {
    requested: "https://www.amazon.co.jp/ap/signin",
    finalUrl: "https://www.amazon.co.jp/ap/signin?x=1",
    expected: false,
    why: "the request itself asked for the sign-in page",
  },
  {
    requested: "https://example.com/a",
    finalUrl: "not a url",
    expected: false,
    why: "an unparsable final URL",
  },
  {
    requested: "https://example.com/a",
    finalUrl: "https://auth.example.com/authorize",
    expected: true,
    why: "an auth host label and an authorize segment",
  },
  {
    requested: "https://example.com/a",
    finalUrl: "https://example.com/catalog?view=list",
    expected: false,
    why: "an ordinary query",
  },
];

for (const row of TRUTH_TABLE) {
  test(`isLoginRedirect is ${row.expected} for ${row.finalUrl ?? "null"} (${row.why})`, () => {
    assert.equal(isLoginRedirect(row.requested, row.finalUrl), row.expected);
  });
}

test("describeLoginPage keeps the origin and path and drops the query and fragment", () => {
  assert.equal(
    describeLoginPage("https://www.amazon.co.jp/ap/signin?openid.return_to=x#f"),
    "https://www.amazon.co.jp/ap/signin",
  );
});

test("describeLoginPage names an address it cannot parse without throwing", () => {
  assert.equal(describeLoginPage("not a url"), "an unrecognised address");
});
