import { open, Database, RootDatabase } from "lmdb";
import type { AuditLogEntry, AuditLogQuery, AuditLogRepository, AuditEventType } from "./AuditLogRepository";
import logger from "../utils/logger";

interface StoredAuditEntry {
    id: string;
    timestamp: string;
    eventType: AuditEventType;
    category: "trade" | "risk" | "strategy" | "system";
    symbol?: string;
    message: string;
    details?: Record<string, unknown>;
    severity: "info" | "warn" | "error";
}

/**
 * LMDB-backed audit log repository.
 * Uses timestamp-based keys for efficient time-range queries.
 * 
 * @performance Current implementation scans all logs for filtering (O(N)).
 * Queries are limited to prevent excessive memory usage. For high-volume
 * production use (>10k logs/day), consider:
 * - Adding secondary indices for eventType/symbol
 * - Using a dedicated time-series database
 * - Implementing date-based partitioning
 */
// TODO: Add secondary indices for performance (Issue #9)
export class LmdbAuditLogRepository implements AuditLogRepository {
    private db: RootDatabase;
    private logs: Database<StoredAuditEntry, string>;
    private readonly path: string;

    constructor(path: string) {
        this.path = path;
        this.db = open({
            path,
            compression: true,
            maxDbs: 2,
        });
        this.logs = this.db.openDB<StoredAuditEntry, string>({
            name: "audit-logs",
        });
    }

    async initialize(): Promise<void> {
        logger.info({ path: this.path }, "Audit log repository initialized");
    }

    async append(entry: AuditLogEntry): Promise<void> {
        // Key format: timestamp-uuid for chronological ordering
        const key = `${entry.timestamp.toISOString()}-${entry.id}`;

        const stored: StoredAuditEntry = {
            ...entry,
            timestamp: entry.timestamp.toISOString(),
        };

        await this.logs.put(key, stored);
    }

    async query(query: AuditLogQuery): Promise<AuditLogEntry[]> {
        const results: AuditLogEntry[] = [];
        const limit = query.limit ?? 100;
        const offset = query.offset ?? 0;

        // Build key range for time-based filtering
        const startKey = query.fromDate?.toISOString() ?? "";
        const endKey = query.toDate?.toISOString() ?? "\uffff";

        let count = 0;
        let skipped = 0;

        for (const { value } of this.logs.getRange({ start: startKey, end: endKey, reverse: true })) {
            // Apply filters
            if (query.eventTypes && query.eventTypes.length > 0) {
                if (!query.eventTypes.includes(value.eventType)) continue;
            }
            if (query.symbol && value.symbol !== query.symbol.toUpperCase()) continue;
            if (query.category && value.category !== query.category) continue;
            if (query.severity && value.severity !== query.severity) continue;

            // Handle pagination
            if (skipped < offset) {
                skipped++;
                continue;
            }

            results.push({
                ...value,
                timestamp: new Date(value.timestamp),
            });

            count++;
            if (count >= limit) break;
        }

        return results;
    }

    async getToday(): Promise<AuditLogEntry[]> {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        return this.query({
            fromDate: today,
            limit: 500,
        });
    }

    async getStats(): Promise<Record<AuditEventType, number>> {
        const stats: Partial<Record<AuditEventType, number>> = {};

        for (const { value } of this.logs.getRange({})) {
            stats[value.eventType] = (stats[value.eventType] ?? 0) + 1;
        }

        return stats as Record<AuditEventType, number>;
    }

    async cleanup(olderThan: Date): Promise<number> {
        const cutoffKey = olderThan.toISOString();
        let deleted = 0;

        const keysToDelete: string[] = [];

        for (const { key } of this.logs.getRange({ end: cutoffKey })) {
            keysToDelete.push(key);
        }

        for (const key of keysToDelete) {
            await this.logs.remove(key);
            deleted++;
        }

        if (deleted > 0) {
            logger.info({ deleted, olderThan: olderThan.toISOString() }, "Audit log cleanup completed");
        }

        return deleted;
    }

    async close(): Promise<void> {
        await this.db.close();
    }
}
