/**
 * Audit log types and repository interface
 */

export type AuditEventType =
    | "TRADE_EXECUTED"
    | "TRADE_FAILED"
    | "STOP_LOSS_TRIGGERED"
    | "STOP_LOSS_EXECUTED"
    | "STOP_LOSS_CREATED"
    | "STOP_LOSS_UPDATED"
    | "STOP_LOSS_REMOVED"
    | "STRATEGY_SIGNAL"
    | "STRATEGY_EVALUATION"
    | "SETTINGS_CHANGED"
    | "CIRCUIT_BREAKER_TRIGGERED"
    | "TRADING_STARTED"
    | "TRADING_STOPPED"
    | "PANIC_SELL"
    | "RECONCILIATION"
    | "SYSTEM";

export interface AuditLogEntry {
    id: string;
    timestamp: Date;
    eventType: AuditEventType;
    category: "trade" | "risk" | "strategy" | "system";
    symbol?: string;
    message: string;
    details?: Record<string, unknown>;
    severity: "info" | "warn" | "error";
}

export interface AuditLogQuery {
    fromDate?: Date;
    toDate?: Date;
    eventTypes?: AuditEventType[];
    symbol?: string;
    category?: string;
    severity?: string;
    limit?: number;
    offset?: number;
}

export interface AuditLogRepository {
    initialize(): Promise<void>;

    /**
     * Add a new audit log entry
     */
    append(entry: AuditLogEntry): Promise<void>;

    /**
     * Query audit logs with filters
     */
    query(query: AuditLogQuery): Promise<AuditLogEntry[]>;

    /**
     * Get entries from today
     */
    getToday(): Promise<AuditLogEntry[]>;

    /**
     * Get count of entries by event type
     */
    getStats(): Promise<Record<AuditEventType, number>>;

    /**
     * Clear old entries (retention policy)
     */
    cleanup(olderThan: Date): Promise<number>;

    close(): Promise<void>;
}
