/**
 * Spotting a fetch that a site bounced to its sign-in page.
 *
 * There are no per-site rules: a redirect is judged by the shape of the final
 * URL alone. A site that shows its login form without redirecting is missed.
 */

/** A path segment that names a sign-in step, matched whole. */
const LOGIN_SEGMENT = /^(sign[-_]?in|log[-_]?in|logon|sso|authorize)$/i;

/** The first label of a host that exists only to sign people in. */
const LOGIN_HOST_LABEL = /^(login|signin|sso|auth)$/i;

/** A query value that asks for the login step (`?__event=login`). */
const LOGIN_QUERY_VALUE = /^log[-_]?in$/i;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function looksLikeLogin(url: URL): boolean {
  if (url.pathname.split("/").some((s) => LOGIN_SEGMENT.test(decodeSegment(s)))) {
    return true;
  }
  if (LOGIN_HOST_LABEL.test(url.hostname.split(".")[0] ?? "")) return true;
  for (const value of url.searchParams.values()) {
    if (LOGIN_QUERY_VALUE.test(value)) return true;
  }
  return false;
}

/** True when finalUrl looks like a sign-in page the request was sent to. Pure; never throws. */
export function isLoginRedirect(requested: string, finalUrl: string | null): boolean {
  if (finalUrl === null) return false;
  const final = parse(finalUrl);
  if (final === null) return false;
  // Asking for the sign-in page on purpose is not a lost login.
  const asked = parse(requested);
  if (asked !== null && looksLikeLogin(asked)) return false;
  return looksLikeLogin(final);
}

/** "origin + pathname" of a URL, for messages. Never includes the query or fragment. */
export function describeLoginPage(finalUrl: string): string {
  const url = parse(finalUrl);
  return url === null ? "an unrecognised address" : url.origin + url.pathname;
}
