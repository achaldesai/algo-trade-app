import { open, type Database, type RootDatabase } from "lmdb";
import { EventEmitter } from "events";
import path from "path";
import fs from "fs/promises";
import type { SettingsRepository } from "./SettingsRepository";
import type { RiskLimits } from "../services/RiskManager";
import env from "../config/env";

export class LmdbSettingsRepository extends EventEmitter implements SettingsRepository {
    private root: RootDatabase | null = null;
    private db: Database<RiskLimits> | null = null;
    private initPromise: Promise<void> | null = null;

    // Default values from env
    private readonly defaults: RiskLimits = {
        maxDailyLoss: Number(env.maxDailyLoss || 5000),
        maxDailyLossPercent: Number(env.maxDailyLossPercent || 2),
        maxPositionSize: 100000, // Reasonable default if not in env
        maxOpenPositions: Number(env.maxOpenPositions || 5),
        stopLossPercent: Number(env.stopLossPercent || 3)
    };

    private cache = new Map<string, RiskLimits>();

    constructor(private readonly storePath: string) {
        super();
    }

    /**
     * Initialize the LMDB database
     * Uses promise-tracking to prevent race conditions on concurrent initialization
     */
    async initialize(): Promise<void> {
        if (this.root) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = this.doInitialize();
        try {
            return await this.initPromise;
        } finally {
            this.initPromise = null;
        }
    }

    private async doInitialize(): Promise<void> {
        await fs.mkdir(path.dirname(this.storePath), { recursive: true });

        this.root = open({
            path: this.storePath,
            compression: true,
        });

        this.db = this.root.openDB<RiskLimits>({
            name: "settings",
            encoding: "json",
        });

        // Load into cache
        for (const { key, value } of this.db.getRange()) {
            if (typeof key === "string" && key.startsWith("riskLimits:")) {
                const userId = key.split(":")[1];
                if (userId) {
                    this.cache.set(userId, { ...this.defaults, ...value });
                }
            }
        }
    }

    getRiskLimits(userId: string): RiskLimits {
        const cached = this.cache.get(userId);
        if (cached) return { ...cached };

        // Return default limits synchronously if missing
        return { ...this.defaults };
    }

    async saveRiskLimits(userId: string, limits: RiskLimits): Promise<void> {
        if (!this.db) await this.initialize();
        if (!this.db) throw new Error("Failed to initialize settings database");
        await this.db.put(`riskLimits:${userId}`, limits);
        this.cache.set(userId, { ...limits });
        this.emit(`updated:${userId}`, limits);

        // Backwards compatibility for global event listener (can be removed later)
        this.emit("updated", limits);
    }

    async resetToDefaults(userId: string): Promise<RiskLimits> {
        await this.saveRiskLimits(userId, this.defaults);
        return this.defaults;
    }

    async close(): Promise<void> {
        if (this.root) {
            await this.root.close();
            this.root = null;
            this.db = null;
        }
    }
}
