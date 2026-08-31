import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { DENIED_CIDRS } from "./ranges.js";
import { failure, type ToolFailure } from "../utils/errors.js";

/**
 * Decide whether a URL may be fetched.
 *
 * ## What this is, and what it is not
 *
 * This check resolves the hostname and refuses the request when any resulting
 * address falls in a denied range. It runs before the URL is handed to the
 * scraping backend, so the caller gets a precise reason rather than a timeout.
 *
 * It is **not** the security boundary. A name can resolve to a public address
 * here and to a private one microseconds later when the browser resolves it
 * again - the classic rebinding race, which no amount of application-level
 * checking closes. The authoritative control is a packet filter applied to the
 * scraping container's subnet during deployment. This function exists so that a
 * blocked target produces an intelligible error instead of a mysterious hang,
 * and so the common case is refused before a browser is ever started.
 */

type ParsedRange = [ipaddr.IPv4 | ipaddr.IPv6, number];

function parseCidrs(cidrs: readonly string[], label: string): ParsedRange[] {
  return cidrs.map((cidr) => {
    try {
      return ipaddr.parseCIDR(cidr);
    } catch {
      throw new Error(`${label} contains an invalid CIDR: ${cidr}`);
    }
  });
}

const DENIED: ParsedRange[] = parseCidrs(DENIED_CIDRS, "DENIED_CIDRS");

function inAny(addr: ipaddr.IPv4 | ipaddr.IPv6, ranges: ParsedRange[]): boolean {
  return ranges.some(([net, bits]) => {
    // match() throws when the address families differ, which is a "no", not an
    // error. An IPv4-mapped IPv6 address is unwrapped so the v4 rules apply.
    const candidate =
      addr.kind() === "ipv6" &&
      (addr as ipaddr.IPv6).isIPv4MappedAddress() &&
      net.kind() === "ipv4"
        ? (addr as ipaddr.IPv6).toIPv4Address()
        : addr;
    if (candidate.kind() !== net.kind()) return false;
    return candidate.match(net as never, bits);
  });
}

export interface EgressPolicy {
  /** Extra ranges the operator has explicitly allowed. */
  readonly allow: readonly string[];
}

export interface EgressDecision {
  readonly allowed: boolean;
  readonly addresses: readonly string[];
  readonly failure: ToolFailure | null;
}

/**
 * Check one URL against the policy.
 *
 * Every address the name resolves to is examined, not just the first. A host
 * with one public A record and one private AAAA record is refused: taking the
 * first answer would make the outcome depend on resolver ordering.
 */
export async function checkEgress(
  rawUrl: string,
  policy: EgressPolicy,
): Promise<EgressDecision> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      allowed: false,
      addresses: [],
      failure: failure("invalidInput", `Not a valid URL: ${rawUrl}`),
    };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      allowed: false,
      addresses: [],
      failure: failure(
        "egressDenied",
        `Only http and https targets are allowed, got "${url.protocol}".`,
      ),
    };
  }

  const allowed = parseCidrs(policy.allow, "SCRAPE_ALLOW_CIDRS");
  const host = url.hostname.replace(/^\[|\]$/g, "");

  // A literal address needs no resolution, and passing one to lookup() would
  // just echo it back.
  let addresses: string[];
  if (ipaddr.isValid(host)) {
    addresses = [host];
  } else {
    try {
      const records = await lookup(host, { all: true });
      addresses = records.map((r) => r.address);
    } catch {
      return {
        allowed: false,
        addresses: [],
        failure: failure("unreachable", `Could not resolve "${host}".`),
      };
    }
  }

  if (addresses.length === 0) {
    return {
      allowed: false,
      addresses: [],
      failure: failure("unreachable", `"${host}" resolved to no addresses.`),
    };
  }

  for (const address of addresses) {
    const parsed = ipaddr.parse(address);
    if (inAny(parsed, allowed)) continue;
    if (inAny(parsed, DENIED)) {
      return {
        allowed: false,
        addresses,
        failure: failure(
          "egressDenied",
          `"${host}" resolves to ${address}, which is in a range this server refuses to fetch ` +
            `(private, loopback, link-local, carrier-NAT or cloud metadata). ` +
            `This is a policy decision, not a connectivity problem. ` +
            `An operator can permit specific ranges through SCRAPE_ALLOW_CIDRS.`,
        ),
      };
    }
  }

  return { allowed: true, addresses, failure: null };
}
