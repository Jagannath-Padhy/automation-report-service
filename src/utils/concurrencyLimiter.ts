/**
 * Minimal counting semaphore used to cap how many concurrent network calls
 * this service fires at a given downstream dependency, independent of how
 * many callers (flows/actions) try to run at once. No external dependency
 * (e.g. p-limit) needed for this.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
