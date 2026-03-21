import type { Pool } from "pg";
import type {
    AuditLogEntry,
    AuditLogQuery,
    AuditEventType,
} from "../../persistence/AuditLogRepository";

/**
 * PgAuditLogRepo — PostgreSQL-backed audit log repository.
 *
 * Provides indexed queries by event type, symbol, user, and time range.
 * Supports efficient cleanup with time-based deletion.
 */
export class PgAuditLogRepo {
    constructor(private readonly pool: Pool) { }

    async append(entry: AuditLogEntry): Promise<void> {
        await this.pool.query(
            `INSERT INTO audit_logs (id, user_id, timestamp, event_type, category, symbol, message, details, severity)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO NOTHING`,
            [
                entry.id,
                entry.userId,
                entry.timestamp,
                entry.eventType,
                entry.category,
                entry.symbol ?? null,
                entry.message,
                entry.details ? JSON.stringify(entry.details) : null,
                entry.severity,
            ]
        );
    }

    async query(q: AuditLogQuery): Promise<AuditLogEntry[]> {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (q.userId) {
            conditions.push(`user_id = $${paramIdx++}`);
            params.push(q.userId);
        }
        if (q.fromDate) {
            conditions.push(`timestamp >= $${paramIdx++}`);
            params.push(q.fromDate);
        }
        if (q.toDate) {
            conditions.push(`timestamp <= $${paramIdx++}`);
            params.push(q.toDate);
        }
        if (q.eventTypes && q.eventTypes.length > 0) {
            conditions.push(`event_type = ANY($${paramIdx++})`);
            params.push(q.eventTypes);
        }
        if (q.symbol) {
            conditions.push(`symbol = $${paramIdx++}`);
            params.push(q.symbol.toUpperCase());
        }
        if (q.category) {
            conditions.push(`category = $${paramIdx++}`);
            params.push(q.category);
        }
        if (q.severity) {
            conditions.push(`severity = $${paramIdx++}`);
            params.push(q.severity);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const limit = q.limit ?? 100;
        const offset = q.offset ?? 0;

        const result = await this.pool.query(
            `SELECT * FROM audit_logs ${where}
             ORDER BY timestamp DESC
             LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
            [...params, limit, offset]
        );

        return result.rows.map(toEntry);
    }

    async getToday(userId?: string): Promise<AuditLogEntry[]> {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        return this.query({
            userId,
            fromDate: today,
            limit: 500,
        });
    }

    async getStats(): Promise<Record<string, number>> {
        const result = await this.pool.query(
            "SELECT event_type, COUNT(*) as count FROM audit_logs GROUP BY event_type"
        );

        const stats: Record<string, number> = {};
        for (const row of result.rows) {
            stats[row.event_type] = parseInt(row.count, 10);
        }
        return stats;
    }

    async cleanup(olderThan: Date): Promise<number> {
        const result = await this.pool.query(
            "DELETE FROM audit_logs WHERE timestamp < $1",
            [olderThan]
        );
        return result.rowCount ?? 0;
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEntry(row: any): AuditLogEntry {
    return {
        id: row.id,
        userId: row.user_id,
        timestamp: new Date(row.timestamp),
        eventType: row.event_type as AuditEventType,
        category: row.category,
        symbol: row.symbol ?? undefined,
        message: row.message,
        details: row.details ?? undefined,
        severity: row.severity,
    };
}
