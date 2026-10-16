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
