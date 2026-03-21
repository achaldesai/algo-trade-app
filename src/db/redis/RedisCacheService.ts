import type { RedisManager } from "./RedisManager";
import logger from "../../utils/logger";

/**
 * RedisCacheService — generic key-value cache backed by Redis.
 *
 * Provides typed get/set/del operations with TTL support.
 * Falls back gracefully on Redis errors (returns null / logs warning).
 */
export class RedisCacheService {
    constructor(private readonly redis: RedisManager) { }

    /**
     * Get a cached value.
     */
    async get<T>(key: string): Promise<T | null> {
        try {
            const raw = await this.redis.client.get(key);
            if (raw === null) return null;
            return JSON.parse(raw) as T;
        } catch (err) {
            logger.warn({ err, key }, "Redis cache get failed");
            return null;
        }
    }

    /**
     * Set a cached value with TTL in seconds.
     */
    async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
        try {
            const serialized = JSON.stringify(value);
            await this.redis.client.setex(key, ttlSeconds, serialized);
        } catch (err) {
            logger.warn({ err, key }, "Redis cache set failed");
        }
    }

    /**
     * Delete a cached key.
     */
    async del(key: string): Promise<void> {
        try {
            await this.redis.client.del(key);
        } catch (err) {
            logger.warn({ err, key }, "Redis cache del failed");
        }
    }

    /**
     * Delete all keys matching a pattern.
     * Uses SCAN to avoid blocking Redis on large datasets.
     */
    async delPattern(pattern: string): Promise<number> {
        let deleted = 0;
        try {
            const stream = this.redis.client.scanStream({
                match: pattern,
                count: 100,
            });

            for await (const keys of stream) {
                if ((keys as string[]).length > 0) {
                    const count = await this.redis.client.del(...(keys as string[]));
                    deleted += count;
                }
            }
        } catch (err) {
            logger.warn({ err, pattern }, "Redis cache delPattern failed");
        }
        return deleted;
    }
}
