/**
 * Fixed-size circular buffer for efficient storage of streaming data.
 * Pre-allocates memory to avoid garbage collection overhead.
 */
export class RingBuffer<T> {
    private buffer: (T | undefined)[];
    private head = 0;
    private _size = 0;

    constructor(private readonly capacity: number) {
        if (capacity <= 0) {
            throw new Error("RingBuffer capacity must be positive");
        }
        this.buffer = new Array(capacity);
    }

    /**
     * Add an item to the buffer. O(1) operation.
     * If buffer is full, oldest item is overwritten.
     */
    push(item: T): void {
        this.buffer[this.head] = item;
        this.head = (this.head + 1) % this.capacity;
        if (this._size < this.capacity) {
            this._size++;
        }
    }

    /**
     * Get item at logical index (0 = oldest, size-1 = newest). O(1) operation.
     */
    get(index: number): T | undefined {
        if (index < 0 || index >= this._size) {
            return undefined;
        }
        // Calculate actual buffer position
        const start = this._size < this.capacity ? 0 : this.head;
        const actualIndex = (start + index) % this.capacity;
        return this.buffer[actualIndex];
    }

    /**
     * Get the most recent item. O(1) operation.
     */
    peek(): T | undefined {
        if (this._size === 0) return undefined;
        const lastIndex = (this.head - 1 + this.capacity) % this.capacity;
        return this.buffer[lastIndex];
    }

    /**
     * Get the last N items as an array (newest last). O(n) operation.
     */
    last(n: number): T[] {
        const count = Math.min(n, this._size);
        const result: T[] = new Array(count);
        for (let i = 0; i < count; i++) {
            result[i] = this.get(this._size - count + i) as T;
        }
        return result;
    }

    /**
     * Convert entire buffer to array (oldest first). O(n) operation.
     */
    toArray(): T[] {
        const result: T[] = new Array(this._size);
        for (let i = 0; i < this._size; i++) {
            result[i] = this.get(i) as T;
        }
        return result;
    }

    /**
     * Current number of items in buffer.
     */
    get size(): number {
        return this._size;
    }

    /**
     * Maximum capacity of buffer.
     */
    get maxSize(): number {
        return this.capacity;
    }

    /**
     * Whether buffer is at capacity.
     */
    isFull(): boolean {
        return this._size === this.capacity;
    }

    /**
     * Clear all items from buffer.
     */
    clear(): void {
        this.buffer = new Array(this.capacity);
        this.head = 0;
        this._size = 0;
    }
}

export default RingBuffer;
