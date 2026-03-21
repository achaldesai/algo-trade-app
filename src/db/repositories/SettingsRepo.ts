
import { EventEmitter } from "events";
import type DatabaseManager from "../DatabaseManager";
import logger from "../../utils/logger";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RiskLimits {
    maxDailyLoss: number;
    maxDailyLossPercent: number;
    maxPositionSize: number;
    maxOpenPositions: number;
    stopLossPercent: number;
    circuitBroken?: boolean;
}

// ─── Repository ──────────────────────────────────────────────────────────────

/**
 * SettingsRepo manages per-user risk limit configuration.
 *
 * Reads are served from an in-memory cache (populated on init) for O(1) access
 * in the hot path. Writes go to LMDB and update the cache.
 *
 * Emits:
 *   - `updated: <userId>` with the new RiskLimits
 *   - `updated` (global, for backward compat)
 */
export class SettingsRepo extends EventEmitter {
    private readonly db: DatabaseManager;
    private readonly cache = new Map<string, RiskLimits>();
    private readonly defaults: RiskLimits;

    constructor(db: DatabaseManager, defaults: RiskLimits) {
        super();
        this.db = db;
        this.defaults = { ...defaults };
    }

    /**
     * Load all persisted settings into the in-memory cache.
     * Call once after DatabaseManager.open().
     */
    load(): void {
        const { settings } = this.db.handles;

        for (const { key, value } of settings.getRange()) {
            if (typeof key === "string" && key.startsWith("riskLimits:")) {
                // Trim to tolerate legacy keys accidentally stored with trailing spaces.
                const userId = key.slice("riskLimits:".length).trim();
                if (userId) {
                    this.cache.set(userId, { ...this.defaults, ...value });
                }
            }
        }

        logger.info({ count: this.cache.size }, "SettingsRepo loaded");
    }

    /**
     * Get risk limits for a user. Returns defaults if no custom settings exist.
     * Always returns a copy so callers can't mutate the cache.
     */
    getRiskLimits(userId: string): RiskLimits {
        const cached = this.cache.get(userId);
        if (cached) return { ...cached };
        return { ...this.defaults };
    }

    /**
     * Persist risk limits for a user.
     */
    async saveRiskLimits(userId: string, limits: RiskLimits): Promise<void> {
        const { settings } = this.db.handles;
        await settings.put(`riskLimits:${userId}`, limits);
        this.cache.set(userId, { ...limits });

        this.emit(`updated:${userId}`, limits);
        this.emit("updated", limits, userId);
    }

    /**
     * Reset a user's risk limits to the configured defaults.
     */
    async resetToDefaults(userId: string): Promise<RiskLimits> {
        await this.saveRiskLimits(userId, this.defaults);
        return { ...this.defaults };
    }

    /**
     * Get the default risk limits.
     */
    getDefaults(): RiskLimits {
        return { ...this.defaults };
    }
}
