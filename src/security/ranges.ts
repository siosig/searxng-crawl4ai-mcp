/**
 * Address ranges that a scrape target may never resolve to.
 *
 * This list is not configurable. Operators can widen the policy by allowing
 * extra ranges (SCRAPE_ALLOW_CIDRS), but they cannot delete an entry here -
 * a deployment that could switch the metadata endpoint back on would defeat
 * the point of having the check.
 */
export const DENIED_CIDRS: readonly string[] = [
  // Loopback
  "127.0.0.0/8",
  "::1/128",
  // RFC1918 private
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  // Unique local (IPv6)
  "fc00::/7",
  // Link-local. 169.254.169.254 - the cloud metadata endpoint - lives in here,
  // and is the single most valuable target for a request-forgery attempt.
  "169.254.0.0/16",
  "fe80::/10",
  // Carrier-grade NAT
  "100.64.0.0/10",
  // "This network"
  "0.0.0.0/8",
  "::/128",
  // IETF protocol assignments
  "192.0.0.0/24",
  // Benchmarking
  "198.18.0.0/15",
  // Reserved / multicast
  "240.0.0.0/4",
  "224.0.0.0/4",
  "ff00::/8",
  // IPv4-mapped IPv6: ::ffff:10.0.0.1 must not slip past the v4 rules.
  "::ffff:0:0/96",
];
