/**
 * Audit log types — domain-level shape used by services and routes.
 * The persisted shape lives in `db/DatabaseManager.ts` (AuditLogRecord).
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
    userId: string;
    timestamp: Date;
    eventType: AuditEventType;
    category: "trade" | "risk" | "strategy" | "system";
    symbol?: string;
    message: string;
    details?: Record<string, unknown>;
    severity: "info" | "warn" | "error";
}

export interface AuditLogQuery {
    userId?: string;
    fromDate?: Date;
    toDate?: Date;
    eventTypes?: AuditEventType[];
    symbol?: string;
    category?: string;
    severity?: string;
    limit?: number;
    offset?: number;
}
