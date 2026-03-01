import { open, type Database, type RootDatabase } from "lmdb";
import { EventEmitter } from "events";
import path from "path";
import fs from "fs/promises";
import type { StopLossConfig, StopLossRepository } from "./StopLossRepository";
import logger from "../utils/logger";

interface StoredStopLossConfig {
    symbol: string;
    userId: string;
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

    getAll(userId: string): StopLossConfig[] {
        return Array.from(this.cache.values()).filter(c => c.userId === userId);
    }

    get(userId: string, symbol: string): StopLossConfig | undefined {
        return this.cache.get(`${userId}:${symbol.toUpperCase()}`);
    }

    getBySymbol(symbol: string): StopLossConfig[] {
        const upperSymbol = symbol.toUpperCase();
        return Array.from(this.cache.values()).filter(c => c.symbol === upperSymbol);
    }

    async save(config: StopLossConfig): Promise<void> {
        if (!this.db) await this.initialize();

        const symbol = config.symbol.toUpperCase();
        const userId = config.userId;
        const normalized: StopLossConfig = {
            ...config,
            symbol,
            updatedAt: new Date(),
        };

        const key = `${userId}:${symbol}`;
        await this.db!.put(key, this.serialize(normalized));
        this.cache.set(key, normalized);

        this.emit(`saved:${userId}`, normalized);
        // Retain backward compat event for now
        this.emit("saved", normalized);
        logger.info({ userId, symbol, stopLossPrice: normalized.stopLossPrice, type: normalized.type }, "Stop-loss saved");
    }

    async delete(userId: string, symbol: string): Promise<void> {
        if (!this.db) await this.initialize();

        const upperSymbol = symbol.toUpperCase();
        const key = `${userId}:${upperSymbol}`;
        const existing = this.cache.get(key);

        if (existing) {
            await this.db!.remove(key);
            this.cache.delete(key);
            this.emit(`deleted:${userId}`, upperSymbol);
            // Retain backward compat event for now
            this.emit("deleted", upperSymbol);
            logger.info({ userId, symbol: upperSymbol }, "Stop-loss deleted");
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
