import Redis from "ioredis";
import logger from "../../utils/logger";

/**
 * RedisManager manages a single ioredis connection.
 *
 * Lifecycle:
 *   const redis = new RedisManager("redis://localhost:6379");
 *   await redis.connect();
 *   // ... use redis.client
 *   await redis.close();
 */
export class RedisManager {
    private _client: Redis | null = null;

    constructor(private readonly url: string) { }

    /**
     * Create the connection and verify connectivity.
     */
    async connect(): Promise<void> {
        if (this._client) return;

        this._client = new Redis(this.url, {
            maxRetriesPerRequest: 3,
            retryStrategy(times: number) {
                if (times > 10) return null; // Stop retrying after 10 attempts
                return Math.min(times * 200, 5000);
            },
            lazyConnect: true,
        });

        this._client.on("error", (err) => {
            logger.error({ err }, "Redis connection error");
        });

        this._client.on("connect", () => {
            logger.info("Redis connected");
        });

        this._client.on("close", () => {
            logger.info("Redis connection closed");
        });

        await this._client.connect();

        // Verify connectivity
        const pong = await this._client.ping();
        if (pong !== "PONG") {
            throw new Error(`Redis ping failed: ${pong}`);
        }

        logger.info({ url: this.url.replace(/\/\/.*@/, "//***@") }, "Redis ready");
    }

    /**
     * Get the client (throws if not connected).
     */
    get client(): Redis {
        if (!this._client) {
            throw new Error("RedisManager is not connected. Call connect() first.");
        }
        return this._client;
    }

    /**
     * Check if connected.
     */
    get isConnected(): boolean {
        return this._client !== null && this._client.status === "ready";
    }

    /**
     * Disconnect and clean up.
     */
    async close(): Promise<void> {
        if (this._client) {
            await this._client.quit();
            this._client = null;
            logger.info("Redis disconnected");
        }
    }
}
