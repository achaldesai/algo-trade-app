import { EventEmitter } from "events";
import type { StopLossRecord } from "../DatabaseManager";
import type DatabaseManager from "../DatabaseManager";
import logger from "../../utils/logger";

// ─── Types ───────────────────────────────────────────────────────────────────

export type StopLossType = "FIXED" | "TRAILING";

export interface StopLossConfig {
    symbol: string;
    userId: string;
    entryPrice: number;
    stopLossPrice: number;
    quantity: number;
    type: StopLossType;
    trailingPercent?: number;
    highWaterMark?: number;
    createdAt: Date;
    updatedAt: Date;
}

// ─── Repository ──────────────────────────────────────────────────────────────

/**
 * StopLossRepo manages stop-loss configurations.
 *
 * All active stop-losses are cached in memory for O(1) lookup during tick
 * processing. The cache is populated from LMDB on `load()` and kept in sync
 * on every write.
 *
 * Emits:
 *   - `saved:<userId>` / `saved` when a stop-loss is created or updated
 *   - `deleted:<userId>` / `deleted` when a stop-loss is removed
 */
export class StopLossRepo extends EventEmitter {
    private readonly db: DatabaseManager;
    private readonly cache = new Map<string, StopLossConfig>();

    constructor(db: DatabaseManager) {
        super();
        this.db = db;
    }

    /**
     * Load all persisted stop-losses into the in-memory cache.
     * Call once after DatabaseManager.open().
     */
    load(): void {
        const { stopLosses } = this.db.handles;

        for (const { key, value } of stopLosses.getRange()) {
            this.cache.set(key, deserialize(value));
        }

        logger.info({ count: this.cache.size }, "StopLossRepo loaded");
    }

    // ─── Reads (from cache) ────────────────────────────────────────────────────

    getAll(userId: string): StopLossConfig[] {
        return Array.from(this.cache.values()).filter(
            (c) => c.userId === userId
        );
    }

    get(userId: string, symbol: string): StopLossConfig | undefined {
        return this.cache.get(`${userId}:${symbol.toUpperCase()}`);
    }

    getBySymbol(symbol: string): StopLossConfig[] {
        const upper = symbol.toUpperCase();
        return Array.from(this.cache.values()).filter(
            (c) => c.symbol === upper
        );
    }

    // ─── Writes (LMDB + cache) ─────────────────────────────────────────────────

    async save(config: StopLossConfig): Promise<void> {
        const { stopLosses } = this.db.handles;
        const symbol = config.symbol.toUpperCase();
        const key = `${config.userId}:${symbol}`;

        const normalized: StopLossConfig = {
            ...config,
            symbol,
            updatedAt: new Date(),
        };

        await stopLosses.put(key, serialize(normalized));
        this.cache.set(key, normalized);

        this.emit(`saved:${config.userId}`, normalized);
        this.emit("saved", normalized);

        logger.info(
            {
                userId: config.userId,
                symbol,
                stopLossPrice: normalized.stopLossPrice,
                type: normalized.type,
            },
            "Stop-loss saved"
        );
    }

    async delete(userId: string, symbol: string): Promise<void> {
        const { stopLosses } = this.db.handles;
        const upper = symbol.toUpperCase();
        const key = `${userId}:${upper}`;

        const existing = this.cache.get(key);
        if (existing) {
            await stopLosses.remove(key);
            this.cache.delete(key);

            this.emit(`deleted:${userId}`, upper);
            this.emit("deleted", upper);

            logger.info({ userId, symbol: upper }, "Stop-loss deleted");
        }
    }
}

// ─── Serialization ───────────────────────────────────────────────────────────

function serialize(config: StopLossConfig): StopLossRecord {
    return {
        ...config,
        createdAt: config.createdAt.toISOString(),
        updatedAt: config.updatedAt.toISOString(),
    };
}

function deserialize(stored: StopLossRecord): StopLossConfig {
    return {
        ...stored,
        createdAt: new Date(stored.createdAt),
        updatedAt: new Date(stored.updatedAt),
    };
}
