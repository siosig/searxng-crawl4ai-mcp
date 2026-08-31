import { timingSafeEqual } from "node:crypto";

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself reveal the
 * expected length, so both sides are hashed to a fixed width first.
 */
function secretsMatch(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) {
    // Still do a comparison so the failure costs the same either way.
    const filler = Buffer.alloc(32);
    timingSafeEqual(filler, filler);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Pull the token out of an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export function isAuthorized(
  header: string | null | undefined,
  expectedToken: string,
): boolean {
  const presented = bearerToken(header);
  if (presented === null) return false;
  return secretsMatch(presented, expectedToken);
}

/**
 * Strip the port from a Host or Origin value.
 *
 * The allow-list is written as hostnames, because the port a reverse proxy
 * happens to use is not a security property and pinning it only produces
 * confusing outages.
 */
function hostname(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    // Origin arrives as a URL; Host does not.
    if (trimmed.includes("://")) return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
  // Strip a trailing :port, but leave a bracketed IPv6 literal intact.
  const stripped = trimmed.startsWith("[")
    ? trimmed.slice(0, trimmed.indexOf("]") + 1)
    : trimmed.replace(/:\d+$/, "");
  return stripped.toLowerCase() || null;
}

/**
 * Reject requests whose Host or Origin is not one we expect.
 *
 * This is DNS-rebinding protection: a page in someone's browser can be made to
 * resolve an attacker-controlled name to this server's address, but it cannot
 * forge the Host header the proxy in front of us is configured to send.
 *
 * A missing Origin is allowed - non-browser MCP clients do not send one - while
 * a present but unknown Origin is refused.
 */
export function isOriginAllowed(
  host: string | null | undefined,
  origin: string | null | undefined,
  allowedHosts: readonly string[],
): boolean {
  const allowed = new Set(allowedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean));
  if (allowed.size === 0) return false;

  const hostName = host ? hostname(host) : null;
  if (hostName === null || !allowed.has(hostName)) return false;

  if (origin === null || origin === undefined || origin.trim() === "") return true;
  const originName = hostname(origin);
  return originName !== null && allowed.has(originName);
}
