import type {
    AuditLogRecord,
} from "../DatabaseManager";
import type DatabaseManager from "../DatabaseManager";
import type {
    AuditLogEntry,
    AuditLogQuery,
} from "../../persistence/AuditLogRepository";
import logger from "../../utils/logger";

// ─── Repository ──────────────────────────────────────────────────────────────

/**
 * AuditLogRepo persists audit log entries to LMDB.
 *
 * Keys are formatted as `<ISO-timestamp>-<uuid>` for chronological ordering.
 * Time-range queries leverage LMDB's ordered key range scans.
 */
export class AuditLogRepo {
    private readonly db: DatabaseManager;

    constructor(db: DatabaseManager) {
        this.db = db;
    }

    /**
     * Append a new audit log entry.
     */
    async append(entry: AuditLogEntry): Promise<void> {
        const { auditLogs } = this.db.handles;
        const key = `${entry.timestamp.toISOString()}-${entry.id}`;

        const stored: AuditLogRecord = {
            ...entry,
            timestamp: entry.timestamp.toISOString(),
        };

        await auditLogs.put(key, stored);
    }

    /**
     * Query audit logs with filtering and pagination.
     */
    query(query: AuditLogQuery): AuditLogEntry[] {
        const { auditLogs } = this.db.handles;
        const results: AuditLogEntry[] = [];
        const limit = query.limit ?? 100;
        const offset = query.offset ?? 0;

        const startKey = query.fromDate?.toISOString() ?? "";
        const endKey = query.toDate?.toISOString() ?? "\uffff";

        let count = 0;
        let skipped = 0;

        for (const { value } of auditLogs.getRange({
            start: startKey,
            end: endKey,
            reverse: true,
        })) {
            // Apply filters
            if (query.userId && value.userId !== query.userId) continue;
            if (
                query.eventTypes &&
                query.eventTypes.length > 0 &&
                !query.eventTypes.includes(value.eventType)
            )
                continue;
            if (query.symbol && value.symbol !== query.symbol.toUpperCase())
                continue;
            if (query.category && value.category !== query.category) continue;
            if (query.severity && value.severity !== query.severity) continue;

            // Pagination
            if (skipped < offset) {
                skipped++;
                continue;
            }

            results.push(toEntry(value));
            count++;
            if (count >= limit) break;
        }

        return results;
    }

    /**
     * Get all entries from today.
     */
    getToday(userId?: string): AuditLogEntry[] {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        return this.query({
            userId,
            fromDate: today,
            limit: 500,
        });
    }

    /**
     * Get count of entries by event type.
     */
    getStats(): Record<string, number> {
        const { auditLogs } = this.db.handles;
        const stats: Record<string, number> = {};

        for (const { value } of auditLogs.getRange()) {
            stats[value.eventType] = (stats[value.eventType] ?? 0) + 1;
        }

        return stats;
    }

    /**
     * Delete entries older than the given date.
     * @returns Number of entries deleted.
     */
    async cleanup(olderThan: Date): Promise<number> {
        const { auditLogs } = this.db.handles;
        const cutoffKey = olderThan.toISOString();
        const keysToDelete: string[] = [];

        for (const { key } of auditLogs.getRange({ end: cutoffKey })) {
            keysToDelete.push(key);
        }

        // Batch delete in a single transaction
        if (keysToDelete.length > 0) {
            await this.db.withTransaction(async (tx) => {
                for (const key of keysToDelete) {
                    await tx.auditLogs.remove(key);
                }
            });

            logger.info(
                { deleted: keysToDelete.length, olderThan: olderThan.toISOString() },
                "Audit log cleanup completed"
            );
        }

        return keysToDelete.length;
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toEntry(stored: AuditLogRecord): AuditLogEntry {
    return {
        ...stored,
        timestamp: new Date(stored.timestamp),
    };
}
