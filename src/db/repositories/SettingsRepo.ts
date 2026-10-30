
import { EventEmitter } from "events";
import type DatabaseManager from "../DatabaseManager";
import logger from "../../utils/logger";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RiskLimits {
    maxDailyLoss: number;
    maxDailyLossPercent: number;
    maxPositionSize: number;
    maxPositionSizePerSymbol?: number;
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
const UNIVERSE_KEY = "scanner:universe";

export class SettingsRepo extends EventEmitter {
    private readonly db: DatabaseManager;
    private readonly cache = new Map<string, RiskLimits>();
    private readonly defaults: RiskLimits;
    private universeCache: string[] | undefined;

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
            } else if (key === UNIVERSE_KEY && value && Array.isArray((value as { symbols?: unknown }).symbols)) {
                this.universeCache = (value as { symbols: string[] }).symbols;
            }
        }

        logger.info(
            { count: this.cache.size, universeLoaded: this.universeCache !== undefined },
            "SettingsRepo loaded",
        );
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

    /**
     * Get the persisted scanner universe, or undefined if none is configured.
     * Returning undefined lets callers fall back to a code-level default rather
     * than ever silently scanning an empty universe.
     */
    getUniverse(): string[] | undefined {
        return this.universeCache ? [...this.universeCache] : undefined;
    }

    /**
     * Persist the scanner universe (system-wide, not per-user).
     */
    async saveUniverse(symbols: string[]): Promise<void> {
        const { settings } = this.db.handles;
        const normalized = [...new Set(symbols.map(s => s.trim().toUpperCase()).filter(Boolean))];
        await settings.put(UNIVERSE_KEY, { symbols: normalized });
        this.universeCache = normalized;
        this.emit("universe-updated", normalized);
    }
}
