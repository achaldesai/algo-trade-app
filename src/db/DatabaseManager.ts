import { promises as fs } from "node:fs";
import path from "node:path";
import { open, type Database, type RootDatabase } from "lmdb";
import type { TradeSide } from "../types";
import type { AuditEventType } from "../persistence/AuditLogRepository";
import logger from "../utils/logger";

// ─── Stored Record Types ───────────────────────────────────────────────────────

export interface StockRecord {
    userId: string;
    symbol: string;
    name: string;
    createdAt: string;
}

export interface TradeRecord {
    id: string;
    userId: string;
    symbol: string;
    side: TradeSide;
    quantity: number;
    price: number;
    executedAt: string;
    notes?: string;
}

export interface RiskLimitsRecord {
    maxDailyLoss: number;
    maxDailyLossPercent: number;
    maxPositionSize: number;
    maxOpenPositions: number;
    stopLossPercent: number;
    circuitBroken?: boolean;
}

export interface StopLossRecord {
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

export interface AuditLogRecord {
    id: string;
    userId: string;
    timestamp: string;
    eventType: AuditEventType;
    category: "trade" | "risk" | "strategy" | "system";
    symbol?: string;
    message: string;
    details?: Record<string, unknown>;
    severity: "info" | "warn" | "error";
}

export interface ZerodhaTokenRecord {
    accessToken: string;
    expiresAt: string;
    userId: string;
    apiKey: string;
}

export interface AngelOneTokenRecord {
    jwtToken: string;
    refreshToken: string;
    feedToken: string;
    clientId: string;
    expiresAt: string;
}

export type TokenRecord = ZerodhaTokenRecord | AngelOneTokenRecord;

export interface UserRecord {
    id: string;
    username: string;
    passwordHash: string;
    role: "ADMIN" | "USER";
    createdAt: string;
}

export interface StrategyConfigRecord {
    userId: string;
    strategyId: string;
    enabled: boolean;
    params: Record<string, unknown>;
    updatedAt: string;
}

// ─── Named Database Handles ────────────────────────────────────────────────────

export interface DatabaseHandles {
    stocks: Database<StockRecord, string>;
    trades: Database<TradeRecord, string>;
    settings: Database<RiskLimitsRecord, string>;
    stopLosses: Database<StopLossRecord, string>;
    auditLogs: Database<AuditLogRecord, string>;
    tokens: Database<TokenRecord, string>;
    users: Database<UserRecord, string>;
    strategyConfigs: Database<StrategyConfigRecord, string>;
}

// ─── Transaction Context ───────────────────────────────────────────────────────

/**
 * A TransactionContext provides access to all named databases within a single
 * LMDB write transaction. Operations performed through this context are atomic —
 * they either all commit or all roll back.
 */
export interface TransactionContext {
    readonly stocks: Database<StockRecord, string>;
    readonly trades: Database<TradeRecord, string>;
    readonly settings: Database<RiskLimitsRecord, string>;
    readonly stopLosses: Database<StopLossRecord, string>;
    readonly auditLogs: Database<AuditLogRecord, string>;
    readonly tokens: Database<TokenRecord, string>;
    readonly users: Database<UserRecord, string>;
    readonly strategyConfigs: Database<StrategyConfigRecord, string>;
}

// ─── Database Manager ──────────────────────────────────────────────────────────

const MAX_BACKUPS = 7;

/**
 * DatabaseManager is the single owner of the LMDB root database.
 *
 * Guarantees:
 * - One `open()` call per process. All named databases share the same root.
 * - `withTransaction()` provides atomic writes across any combination of
 *   named databases (stocks + trades + audit logs, etc.).
 * - `close()` flushes all pending writes and releases the memory-mapped file.
 * - `backup()` / `restore()` operate on the underlying LMDB directory.
 *
 * Usage:
 *   const db = new DatabaseManager("/path/to/data");
 *   await db.open();
 *   // ... use db.handles or db.withTransaction(...)
 *   await db.close();
 */
export class DatabaseManager {
    private root: RootDatabase | null = null;
    private _handles: DatabaseHandles | null = null;
    private _isOpen = false;

    constructor(private readonly storePath: string) { }

    // ─── Lifecycle ─────────────────────────────────────────────────────────────

    /**
     * Open the LMDB root and all named databases.
     * Idempotent — calling `open()` on an already-open manager is a no-op.
     */
    async open(): Promise<void> {
        if (this._isOpen) return;

        // Ensure the directory exists
        await fs.mkdir(this.storePath, { recursive: true });

        this.root = open({
            path: this.storePath,
            compression: true,
            // LMDB default maxDbs is 12 which is enough for our 8 named DBs
        });

        this._handles = {
            stocks: this.root.openDB<StockRecord, string>({
                name: "stocks",
                encoding: "json",
            }),
            trades: this.root.openDB<TradeRecord, string>({
                name: "trades",
                encoding: "json",
            }),
            settings: this.root.openDB<RiskLimitsRecord, string>({
                name: "settings",
                encoding: "json",
            }),
            stopLosses: this.root.openDB<StopLossRecord, string>({
                name: "stop-losses",
                encoding: "json",
            }),
            auditLogs: this.root.openDB<AuditLogRecord, string>({
                name: "audit-logs",
                encoding: "json",
            }),
            tokens: this.root.openDB<TokenRecord, string>({
                name: "tokens",
                encoding: "json",
            }),
            users: this.root.openDB<UserRecord, string>({
                name: "users",
                encoding: "json",
            }),
            strategyConfigs: this.root.openDB<StrategyConfigRecord, string>({
                name: "strategy-configs",
                encoding: "json",
            }),
        };

        this._isOpen = true;
        logger.info({ path: this.storePath }, "DatabaseManager opened");
    }

    /**
     * Close the LMDB root. Flushes all pending writes.
     * After close(), `handles` and `withTransaction()` will throw.
     */
    async close(): Promise<void> {
        if (!this._isOpen || !this.root) return;

        await this.root.close();
        this.root = null;
        this._handles = null;
        this._isOpen = false;
        logger.info("DatabaseManager closed");
    }

    get isOpen(): boolean {
        return this._isOpen;
    }

    // ─── Database Access ───────────────────────────────────────────────────────

    /**
     * Direct access to all named database handles for reads.
     * LMDB reads are always consistent (MVCC snapshots) and don't need
     * explicit transactions.
     *
     * For writes that must be atomic across multiple DBs, use `withTransaction()`.
     * For single-DB writes, `await db.handles.stocks.put(...)` is fine
     * (each individual put is already its own transaction).
     */
    get handles(): DatabaseHandles {
        if (!this._handles) {
            throw new Error("DatabaseManager is not open. Call open() first.");
        }
        return this._handles;
    }

    // ─── Transactions ──────────────────────────────────────────────────────────

    /**
     * Execute a function within a single LMDB write transaction.
     * All puts/removes performed inside `fn` are atomic — they either all
     * commit or all roll back on error.
     *
     * Example:
     *   await db.withTransaction(async (tx) => {
     *     await tx.stocks.put("user1:RELIANCE", stockRecord);
     *     await tx.trades.put("user1:trade-id", tradeRecord);
     *     await tx.auditLogs.put("2024-01-15T...-uuid", auditRecord);
     *   });
     *
     * Note: LMDB's `transaction()` runs the callback synchronously by default.
     * We use `childTransaction()` approach via the root's `transaction()` method
     * which supports async callbacks and will commit on success / abort on throw.
     */
    async withTransaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
        if (!this.root || !this._handles) {
            throw new Error("DatabaseManager is not open. Call open() first.");
        }

        const handles = this._handles;
        const ctx: TransactionContext = {
            stocks: handles.stocks,
            trades: handles.trades,
            settings: handles.settings,
            stopLosses: handles.stopLosses,
            auditLogs: handles.auditLogs,
            tokens: handles.tokens,
            users: handles.users,
            strategyConfigs: handles.strategyConfigs,
        };

        // lmdb's `transaction()` supports async functions.
        // It wraps the entire callback in a write transaction.
        // If the callback throws, the transaction is aborted.
        return this.root.transaction(async () => {
            return fn(ctx);
        });
    }

    // ─── Backup & Restore ──────────────────────────────────────────────────────

    /**
     * Create a timestamped backup of the LMDB directory.
     * Keeps only the last `MAX_BACKUPS` backups.
     * @returns Absolute path to the created backup directory.
     */
    async createBackup(): Promise<string> {
        const timestamp = new Date()
            .toISOString()
            .replace(/:/g, "-")
            .replace(/\./g, "-");
        const randomSuffix = Math.random().toString(36).substring(2, 8);
        const backupDir = path.join(path.dirname(this.storePath), "backups");
        const backupPath = path.join(
            backupDir,
            `portfolio-${timestamp}-${randomSuffix}`
        );

        await fs.mkdir(backupDir, { recursive: true });
        await fs.cp(this.storePath, backupPath, { recursive: true });
        await this.cleanupOldBackups(backupDir);

        logger.info({ backupPath }, "Database backup created");
        return backupPath;
    }

    /**
     * Restore the database from a backup directory.
     * Closes the current DB, replaces the data dir, and re-opens.
     */
    async restoreFromBackup(backupPath: string): Promise<void> {
        // Verify backup exists
        try {
            await fs.access(backupPath);
        } catch {
            throw new Error(`Backup not found: ${backupPath}`);
        }

        // Close current DB
        await this.close();

        // Replace data directory
        await fs.rm(this.storePath, { recursive: true, force: true });
        await fs.cp(backupPath, this.storePath, { recursive: true });

        // Re-open
        await this.open();
        logger.info({ backupPath }, "Database restored from backup");
    }

    /**
     * List all available backups (newest first).
     */
    async listBackups(): Promise<string[]> {
        const backupDir = path.join(path.dirname(this.storePath), "backups");
        try {
            const entries = await fs.readdir(backupDir);
            return entries
                .filter((name) => name.startsWith("portfolio-"))
                .sort()
                .reverse()
                .map((name) => path.join(backupDir, name));
        } catch {
            return [];
        }
    }

    /**
     * Export all database contents to a plain JSON object.
     */
    async exportToJson(): Promise<{
        stocks: StockRecord[];
        trades: TradeRecord[];
        users: UserRecord[];
        exportedAt: string;
    }> {
        const h = this.handles;
        const stocks: StockRecord[] = [];
        const trades: TradeRecord[] = [];
        const users: UserRecord[] = [];

        for (const { value } of h.stocks.getRange()) stocks.push(value);
        for (const { value } of h.trades.getRange()) trades.push(value);
        for (const { value } of h.users.getRange()) users.push(value);

        return { stocks, trades, users, exportedAt: new Date().toISOString() };
    }

    /**
     * Get database statistics.
     */
    async getStats(): Promise<{
        path: string;
        sizeMB: number;
        stockCount: number;
        tradeCount: number;
        backupCount: number;
        lastBackup: string | null;
    }> {
        const dataFilePath = path.join(this.storePath, "data.mdb");

        try {
            const stats = await fs.stat(dataFilePath);
            const h = this.handles;
            const stockCount = Array.from(h.stocks.getRange()).length;
            const tradeCount = Array.from(h.trades.getRange()).length;
            const backups = await this.listBackups();

            return {
                path: this.storePath,
                sizeMB: Math.round((stats.size / 1024 / 1024) * 100) / 100,
                stockCount,
                tradeCount,
                backupCount: backups.length,
                lastBackup:
                    backups.length > 0 ? path.basename(backups[0]) : null,
            };
        } catch {
            return {
                path: this.storePath,
                sizeMB: 0,
                stockCount: 0,
                tradeCount: 0,
                backupCount: 0,
                lastBackup: null,
            };
        }
    }

    // ─── Private ───────────────────────────────────────────────────────────────

    private async cleanupOldBackups(backupDir: string): Promise<void> {
        try {
            const entries = await fs.readdir(backupDir);
            const backups = entries
                .filter((name) => name.startsWith("portfolio-"))
                .sort();

            if (backups.length > MAX_BACKUPS) {
                const toRemove = backups.slice(0, backups.length - MAX_BACKUPS);
                for (const backup of toRemove) {
                    await fs.rm(path.join(backupDir, backup), {
                        recursive: true,
                    });
                }
            }
        } catch {
            // Ignore cleanup errors — non-critical
        }
    }
}

export default DatabaseManager;
