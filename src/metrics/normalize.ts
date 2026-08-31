/**
 * Fold values that come from upstream into sets we control.
 *
 * A label whose values are chosen by an upstream service is a label whose
 * cardinality is chosen by an upstream service. When that upstream reworks its
 * error strings, the series count grows - and an exploding series count does
 * not just degrade this server's metrics, it degrades the time-series database
 * every other service on the host is sharing.
 *
 * So nothing upstream says becomes a label verbatim.
 */

/** Why a search engine did not answer, in terms we defined. */
export type EngineFailureReason =
  | "captcha"
  | "timeout"
  | "suspended"
  | "error"
  | "other";

/**
 * Classify the reason string a metasearch engine reports.
 *
 * Order matters. Observed values include both "CAPTCHA" and
 * "Suspended: CAPTCHA"; the second is classified as `captcha` rather than
 * `suspended` because the CAPTCHA is the actual cause - the suspension is its
 * consequence, and an operator looking at the dashboard wants to see the cause.
 */
export function engineFailureReason(raw: string): EngineFailureReason {
  const value = raw.toLowerCase();
  if (value.includes("captcha")) return "captcha";
  if (value.includes("timeout") || value.includes("timed out")) return "timeout";
  if (value.includes("suspended")) return "suspended";
  if (value.includes("error") || value.includes("exception")) return "error";
  return "other";
}

/**
 * Bound the number of distinct engine names ever used as a label.
 *
 * Engine names come from the metasearch instance's configuration, so they are
 * finite in practice - but "in practice" is exactly the kind of assumption this
 * project exists to stop relying on. Past the cap, everything collapses to
 * `other`: the dashboard loses some detail, the database does not fall over.
 */
export class BoundedLabelSet {
  readonly #seen = new Set<string>();
  readonly #limit: number;

  constructor(limit = 40) {
    this.#limit = limit;
  }

  /** The label to use for `value`, or `"other"` once the cap is reached. */
  resolve(value: string): string {
    const name = value.trim().toLowerCase();
    if (!name) return "other";
    if (this.#seen.has(name)) return name;
    if (this.#seen.size >= this.#limit) return "other";
    this.#seen.add(name);
    return name;
  }

  get size(): number {
    return this.#seen.size;
  }
}
