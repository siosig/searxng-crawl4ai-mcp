import { failure, UpstreamError } from "./errors.js";
import { recordConcurrencyRejection, recordSlots } from "../metrics/record.js";

/**
 * A fixed number of fetch slots.
 *
 * Every page fetch occupies a browser in the Crawl4AI container, so this is a
 * memory and CPU budget rather than a politeness limit. Callers over the limit
 * are refused immediately instead of queued: an agent that is told "busy, retry"
 * can do something useful, whereas one parked in an invisible queue simply
 * appears to hang, and the queue itself grows without bound.
 */
export class Slots {
  #inUse = 0;
  readonly #limit: number;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`Slot limit must be a positive integer, got ${limit}`);
    }
    this.#limit = limit;
  }

  get limit(): number {
    return this.#limit;
  }

  get inUse(): number {
    return this.#inUse;
  }

  /**
   * Run `work` in a slot, or reject with a `concurrencyLimit` failure when
   * none is free. Never waits.
   */
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#inUse >= this.#limit) {
      recordConcurrencyRejection();
      throw new UpstreamError(
        failure(
          "concurrencyLimit",
          `All ${this.#limit} fetch slots are busy. Retry shortly, or reduce the number of URLs in one call.`,
        ),
      );
    }

    this.#inUse += 1;
    recordSlots(this.#inUse, this.#limit);
    try {
      return await work();
    } finally {
      this.#inUse -= 1;
      recordSlots(this.#inUse, this.#limit);
    }
  }
}
