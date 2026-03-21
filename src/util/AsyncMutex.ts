/**
 * AsyncMutex provides a simple async mutual exclusion lock.
 *
 * Unlike the fragile promise-chain pattern (`this.lock = this.lock.then(...)`)
 * used in the old codebase, this provides proper acquire/release semantics
 * with guaranteed release even on error.
 *
 * Usage:
 *   const mutex = new AsyncMutex();
 *
 *   // Option 1: RAII-style (recommended)
 *   await mutex.runExclusive(async () => {
 *     // ... critical section
 *   });
 *
 *   // Option 2: Manual acquire/release
 *   const release = await mutex.acquire();
 *   try {
 *     // ... critical section
 *   } finally {
 *     release();
 *   }
 */
export class AsyncMutex {
    private queue: Array<() => void> = [];
    private locked = false;

    /**
     * Acquire the lock. Returns a release function that MUST be called
     * when the critical section is complete.
     */
    acquire(): Promise<() => void> {
        return new Promise<() => void>((resolve) => {
            const tryAcquire = () => {
                if (!this.locked) {
                    this.locked = true;
                    resolve(() => this.release());
                } else {
                    this.queue.push(tryAcquire);
                }
            };
            tryAcquire();
        });
    }

    /**
     * Execute `fn` while holding the lock. The lock is released automatically
     * when `fn` completes (or throws).
     */
    async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        const release = await this.acquire();
        try {
            return await fn();
        } finally {
            release();
        }
    }

    get isLocked(): boolean {
        return this.locked;
    }

    private release(): void {
        this.locked = false;
        const next = this.queue.shift();
        if (next) {
            // Yield to the next waiter (in microtask to prevent stack overflow)
            queueMicrotask(next);
        }
    }
}
