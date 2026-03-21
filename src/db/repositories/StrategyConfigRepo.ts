import type { StrategyConfigRecord } from "../DatabaseManager";
import type DatabaseManager from "../DatabaseManager";
import logger from "../../utils/logger";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UserStrategyConfig {
    strategyId: string;
    enabled: boolean;
    params: Record<string, unknown>;
    updatedAt: string;
}

// ─── Repository ──────────────────────────────────────────────────────────────

/**
 * StrategyConfigRepo manages per-user strategy configurations.
 *
 * Reads are served from an in-memory cache (populated on init) for O(1) access
 * in the hot path. Writes go to LMDB and update the cache.
 *
 * Key format in LMDB: `{userId}:{strategyId}`
 */
export class StrategyConfigRepo {
    private readonly db: DatabaseManager;
    // Cache: userId -> Map<strategyId, UserStrategyConfig>
    private readonly cache = new Map<string, Map<string, UserStrategyConfig>>();

    constructor(db: DatabaseManager) {
        this.db = db;
    }

    /**
     * Load all persisted strategy configs into the in-memory cache.
     * Call once after DatabaseManager.open().
     */
    load(): void {
        const { strategyConfigs } = this.db.handles;

        for (const { value } of strategyConfigs.getRange()) {
            if (!value.userId || !value.strategyId) continue;

            let userMap = this.cache.get(value.userId);
            if (!userMap) {
                userMap = new Map();
                this.cache.set(value.userId, userMap);
            }
            userMap.set(value.strategyId, {
                strategyId: value.strategyId,
                enabled: value.enabled,
                params: value.params ?? {},
                updatedAt: value.updatedAt,
            });
        }

        let totalConfigs = 0;
        for (const userMap of this.cache.values()) {
            totalConfigs += userMap.size;
        }
        logger.info(
            { users: this.cache.size, configs: totalConfigs },
            "StrategyConfigRepo loaded"
        );
    }

    /**
     * Get the configuration for a specific strategy for a user.
     * Returns null if no custom config exists.
     */
    getConfig(userId: string, strategyId: string): UserStrategyConfig | null {
        const userMap = this.cache.get(userId);
        if (!userMap) return null;
        const config = userMap.get(strategyId);
        return config ? { ...config, params: { ...config.params } } : null;
    }

    /**
     * Get all strategy configurations for a user (enabled and disabled).
     * Returns an empty array if the user has no custom configs.
     */
    getAllConfigs(userId: string): UserStrategyConfig[] {
        const userMap = this.cache.get(userId);
        if (!userMap) return [];
        return Array.from(userMap.values()).map((c) => ({
            ...c,
            params: { ...c.params },
        }));
    }

    /**
     * Get only the enabled strategy configurations for a user.
     */
    getActiveStrategies(userId: string): UserStrategyConfig[] {
        return this.getAllConfigs(userId).filter((c) => c.enabled);
    }

    /**
     * Save a strategy configuration for a user.
     */
    async saveConfig(
        userId: string,
        config: UserStrategyConfig
    ): Promise<void> {
        const { strategyConfigs } = this.db.handles;
        const key = `${userId}:${config.strategyId}`;

        const record: StrategyConfigRecord = {
            userId,
            strategyId: config.strategyId,
            enabled: config.enabled,
            params: config.params,
            updatedAt: config.updatedAt,
        };

        await strategyConfigs.put(key, record);

        // Update cache
        let userMap = this.cache.get(userId);
        if (!userMap) {
            userMap = new Map();
            this.cache.set(userId, userMap);
        }
        userMap.set(config.strategyId, {
            ...config,
            params: { ...config.params },
        });
    }

    /**
     * Remove a strategy configuration for a user (resets to defaults).
     */
    async deleteConfig(
        userId: string,
        strategyId: string
    ): Promise<boolean> {
        const { strategyConfigs } = this.db.handles;
        const key = `${userId}:${strategyId}`;

        const existing = strategyConfigs.get(key);
        if (!existing) return false;

        await strategyConfigs.remove(key);

        // Update cache
        const userMap = this.cache.get(userId);
        if (userMap) {
            userMap.delete(strategyId);
            if (userMap.size === 0) {
                this.cache.delete(userId);
            }
        }

        return true;
    }
}
