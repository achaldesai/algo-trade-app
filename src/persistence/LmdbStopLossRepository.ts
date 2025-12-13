import { open, type Database, type RootDatabase } from "lmdb";
import { EventEmitter } from "events";
import path from "path";
import fs from "fs/promises";
import type { StopLossConfig, StopLossRepository } from "./StopLossRepository";
import logger from "../utils/logger";

interface StoredStopLossConfig {
    symbol: string;
    entryPrice: number;
    stopLossPrice: number;
    quantity: number;
    type: "FIXED" | "TRAILING";
    trailingPercent?: number;
    highWaterMark?: number;
    createdAt: string;
    updatedAt: string;
}

export class LmdbStopLossRepository extends EventEmitter implements StopLossRepository {
    private root: RootDatabase | null = null;
    private db: Database<StoredStopLossConfig, string> | null = null;

    // In-memory cache for O(1) lookups during tick processing
    private cache = new Map<string, StopLossConfig>();

    constructor(private readonly storePath: string) {
        super();
    }

    async initialize(): Promise<void> {
        if (this.root) return;

        await fs.mkdir(path.dirname(this.storePath), { recursive: true });

        this.root = open({
            path: this.storePath,
            compression: true,
        });

        this.db = this.root.openDB<StoredStopLossConfig, string>({
            name: "stop-losses",
            encoding: "json",
        });

        // Load all into cache
        for (const { key, value } of this.db.getRange()) {
            this.cache.set(key, this.deserialize(value));
        }

        logger.info({ count: this.cache.size }, "StopLoss repository initialized");
    }

    private serialize(config: StopLossConfig): StoredStopLossConfig {
        return {
            ...config,
            createdAt: config.createdAt.toISOString(),
            updatedAt: config.updatedAt.toISOString(),
        };
    }

    private deserialize(stored: StoredStopLossConfig): StopLossConfig {
        return {
            ...stored,
            createdAt: new Date(stored.createdAt),
            updatedAt: new Date(stored.updatedAt),
        };
    }

    getAll(): StopLossConfig[] {
        return Array.from(this.cache.values());
    }

    get(symbol: string): StopLossConfig | undefined {
        return this.cache.get(symbol.toUpperCase());
    }

    async save(config: StopLossConfig): Promise<void> {
        if (!this.db) await this.initialize();

        const symbol = config.symbol.toUpperCase();
        const normalized: StopLossConfig = {
            ...config,
            symbol,
            updatedAt: new Date(),
        };

        await this.db!.put(symbol, this.serialize(normalized));
        this.cache.set(symbol, normalized);

        this.emit("saved", normalized);
        logger.info({ symbol, stopLossPrice: normalized.stopLossPrice, type: normalized.type }, "Stop-loss saved");
    }

    async delete(symbol: string): Promise<void> {
        if (!this.db) await this.initialize();

        const upperSymbol = symbol.toUpperCase();
        const existing = this.cache.get(upperSymbol);

        if (existing) {
            await this.db!.remove(upperSymbol);
            this.cache.delete(upperSymbol);
            this.emit("deleted", upperSymbol);
            logger.info({ symbol: upperSymbol }, "Stop-loss deleted");
        }
    }

    async close(): Promise<void> {
        if (this.root) {
            await this.root.close();
            this.root = null;
            this.db = null;
            this.cache.clear();
        }
    }
}
