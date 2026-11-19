
import { EventEmitter } from "events";
import type DatabaseManager from "../DatabaseManager";
import type { AutoStartRecord, PaperCashRecord } from "../DatabaseManager";
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
const PAPER_CASH_PREFIX = "paperStartingCash:";
const AUTO_START_KEY = "autoStartTrading";

/** Paper-mode account balance before any trades, unless the user sets one. */
export const DEFAULT_PAPER_STARTING_CASH = 100_000;

export class SettingsRepo extends EventEmitter {
    private readonly db: DatabaseManager;
    private readonly cache = new Map<string, RiskLimits>();
    private readonly defaults: RiskLimits;
    private universeCache: string[] | undefined;
    private readonly paperCashCache = new Map<string, number>();
    private autoStartTrading = false;

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
            } else if (typeof key === "string" && key.startsWith(PAPER_CASH_PREFIX)) {
                const amount = (value as PaperCashRecord).amount;
                if (typeof amount === "number") this.paperCashCache.set(key.slice(PAPER_CASH_PREFIX.length), amount);
            } else if (key === AUTO_START_KEY) {
                this.autoStartTrading = (value as AutoStartRecord).enabled === true;
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
     * Whether the morning auto-trading routine may switch trading on by itself
     * (system-wide). Off by default: trading only starts on START.
     */
    getAutoStartTrading(): boolean {
        return this.autoStartTrading;
    }

    async saveAutoStartTrading(enabled: boolean): Promise<void> {
        await this.db.handles.settings.put(AUTO_START_KEY, { enabled });
        this.autoStartTrading = enabled;
    }

    /** Paper-mode starting balance for a user (default ₹1,00,000). */
    getPaperStartingCash(userId: string): number {
        return this.paperCashCache.get(userId) ?? DEFAULT_PAPER_STARTING_CASH;
    }

    async savePaperStartingCash(userId: string, amount: number): Promise<void> {
        const { settings } = this.db.handles;
        await settings.put(`${PAPER_CASH_PREFIX}${userId}`, { amount });
        this.paperCashCache.set(userId, amount);
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
