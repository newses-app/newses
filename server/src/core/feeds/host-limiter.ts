const PRUNE_THRESHOLD = 10_000;

/**
 * Limits concurrent work per key (feed host), queueing the excess in arrival order, and spaces
 * the start of consecutive tasks for the same key by at least `minGapMs`.
 */
export class HostLimiter {
  readonly #perHost: number;
  readonly #minGapMs: number;
  readonly #active = new Map<string, number>();
  readonly #waiting = new Map<string, (() => void)[]>();
  readonly #nextStart = new Map<string, number>();

  constructor(perHost: number, minGapMs = 0) {
    this.#perHost = perHost;
    this.#minGapMs = minGapMs;
  }

  async run<T>(host: string, task: () => Promise<T>): Promise<T> {
    if ((this.#active.get(host) ?? 0) >= this.#perHost) {
      await new Promise<void>((resolve) => {
        const queue = this.#waiting.get(host) ?? [];
        queue.push(resolve);
        this.#waiting.set(host, queue);
      });
    } else {
      this.#active.set(host, (this.#active.get(host) ?? 0) + 1);
    }
    try {
      await this.#spacing(host);
      return await task();
    } finally {
      const next = this.#waiting.get(host)?.shift();
      if (next) next();
      else {
        const remaining = (this.#active.get(host) ?? 1) - 1;
        if (remaining > 0) this.#active.set(host, remaining);
        else this.#active.delete(host);
        this.#waiting.delete(host);
      }
    }
  }

  /** Reserves the host's next start slot synchronously, then waits for it. */
  async #spacing(host: string): Promise<void> {
    if (this.#minGapMs <= 0) return;
    const now = Date.now();
    const start = Math.max(now, this.#nextStart.get(host) ?? 0);
    this.#nextStart.set(host, start + this.#minGapMs);
    if (this.#nextStart.size > PRUNE_THRESHOLD) {
      for (const [key, next] of this.#nextStart) if (next < now) this.#nextStart.delete(key);
    }
    if (start > now) await new Promise((resolve) => setTimeout(resolve, start - now));
  }
}
