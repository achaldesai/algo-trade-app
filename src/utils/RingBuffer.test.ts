import { describe, it } from "node:test";
import assert from "node:assert";
import { RingBuffer } from "./RingBuffer";

describe("RingBuffer", () => {
    it("should initialize with correct capacity", () => {
        const buffer = new RingBuffer<number>(5);
        assert.strictEqual(buffer.maxSize, 5);
        assert.strictEqual(buffer.size, 0);
    });

    it("should push items and increase size", () => {
        const buffer = new RingBuffer<number>(3);
        buffer.push(1);
        assert.strictEqual(buffer.size, 1);
        assert.strictEqual(buffer.get(0), 1);

        buffer.push(2);
        assert.strictEqual(buffer.size, 2);
        assert.strictEqual(buffer.get(0), 1);
        assert.strictEqual(buffer.get(1), 2);
    });

    it("should overwrite oldest items when full", () => {
        const buffer = new RingBuffer<number>(3);
        buffer.push(1);
        buffer.push(2);
        buffer.push(3);

        assert.strictEqual(buffer.size, 3);
        assert.strictEqual(buffer.get(0), 1);
        assert.strictEqual(buffer.get(2), 3);

        // Push 4th item, should overwrite 1
        buffer.push(4);
        assert.strictEqual(buffer.size, 3);
        assert.strictEqual(buffer.get(0), 2); // Oldest becomes 2
        assert.strictEqual(buffer.get(1), 3);
        assert.strictEqual(buffer.get(2), 4);
    });

    it("should handle peek correctly", () => {
        const buffer = new RingBuffer<number>(3);
        assert.strictEqual(buffer.peek(), undefined);

        buffer.push(1);
        assert.strictEqual(buffer.peek(), 1);

        buffer.push(2);
        assert.strictEqual(buffer.peek(), 2);

        buffer.push(3);
        buffer.push(4);
        assert.strictEqual(buffer.peek(), 4);
    });

    it("should return last N items correctly", () => {
        const buffer = new RingBuffer<number>(5);
        buffer.push(1);
        buffer.push(2);
        buffer.push(3);

        const last2 = buffer.last(2);
        assert.deepStrictEqual(last2, [2, 3]);

        buffer.push(4);
        buffer.push(5);
        buffer.push(6); // Overwrites 1. Buffer: [6, 2, 3, 4, 5] (internal storage varies)
        // Logical: 2, 3, 4, 5, 6

        const last3 = buffer.last(3);
        assert.deepStrictEqual(last3, [4, 5, 6]);
    });

    it("should return empty array for last(0)", () => {
        const buffer = new RingBuffer<number>(5);
        buffer.push(1);
        assert.deepStrictEqual(buffer.last(0), []);
    });

    it("should return all items if last(N) where N > size", () => {
        const buffer = new RingBuffer<number>(5);
        buffer.push(1);
        buffer.push(2);
        assert.deepStrictEqual(buffer.last(5), [1, 2]);
    });

    it("should clear the buffer", () => {
        const buffer = new RingBuffer<number>(3);
        buffer.push(1);
        buffer.push(2);
        buffer.clear();
        assert.strictEqual(buffer.size, 0);
        assert.strictEqual(buffer.get(0), undefined);
    });
});
