import { randomUUID } from "crypto";
import type { AuditLogEntry, AuditLogQuery, AuditLogRepository, AuditEventType } from "../persistence/AuditLogRepository";
import type TradingEngine from "./TradingEngine";
import type { StopLossMonitor } from "./StopLossMonitor";
import type { SettingsRepository } from "../persistence/SettingsRepository";
import type { RiskLimits } from "./RiskManager";
import type { Trade } from "../types";
import logger from "../utils/logger";

export interface AuditLogServiceOptions {
    repository: AuditLogRepository;
    tradingEngine?: TradingEngine;
    stopLossMonitor?: StopLossMonitor;
    settingsRepository?: SettingsRepository;
}

/**
 * AuditLogService - Centralized audit logging for all trading events
 * 
 * Automatically logs:
 * - Trade executions (success and failure)
 * - Stop-loss triggers and executions
 * - Settings/config changes
 * - System events (trading start/stop, panic sell)
 */
export class AuditLogService {
    private readonly repository: AuditLogRepository;
    private static instance: AuditLogService | null = null;

    constructor(options: AuditLogServiceOptions) {
        this.repository = options.repository;

        // Subscribe to TradingEngine events
        if (options.tradingEngine) {
            options.tradingEngine.on("trade-executed", (trade: Trade) => {
                void this.logTradeExecuted(trade);
            });
        }

        // Subscribe to StopLossMonitor events
        if (options.stopLossMonitor) {
            options.stopLossMonitor.on("stop-loss-triggered", (event: { config: { symbol: string; stopLossPrice: number }; triggerPrice: number }) => {
                void this.logStopLossTriggered(event);
            });
            options.stopLossMonitor.on("stop-loss-executed", (event: { config: { symbol: string }; execution: unknown }) => {
                void this.logStopLossExecuted(event);
            });
        }

        // Subscribe to Settings changes
        if (options.settingsRepository) {
            options.settingsRepository.on("updated", (limits: RiskLimits) => {
                void this.logSettingsChanged(limits);
            });
        }
    }

    static getInstance(options?: AuditLogServiceOptions): AuditLogService {
        if (!AuditLogService.instance) {
            if (!options) {
                throw new Error("AuditLogService not initialized");
            }
            AuditLogService.instance = new AuditLogService(options);
        }
        return AuditLogService.instance;
    }

    /**
     * Log a trade execution
     */
    async logTradeExecuted(trade: Trade): Promise<void> {
        await this.log({
            eventType: "TRADE_EXECUTED",
            category: "trade",
            symbol: trade.symbol,
            message: `${trade.side} ${trade.quantity} ${trade.symbol} @ ₹${trade.price.toFixed(2)}`,
            details: {
                tradeId: trade.id,
                side: trade.side,
                quantity: trade.quantity,
                price: trade.price,
                executedAt: trade.executedAt.toISOString(),
                notes: trade.notes,
            },
            severity: "info",
        });
    }

    /**
     * Log a trade failure
     */
    async logTradeFailed(symbol: string, side: string, reason: string, details?: Record<string, unknown>): Promise<void> {
        await this.log({
            eventType: "TRADE_FAILED",
            category: "trade",
            symbol,
            message: `Failed ${side} on ${symbol}: ${reason}`,
            details: { side, reason, ...details },
            severity: "error",
        });
    }

    /**
     * Log stop-loss triggered
     */
    async logStopLossTriggered(event: { config: { symbol: string; stopLossPrice: number }; triggerPrice: number }): Promise<void> {
        await this.log({
            eventType: "STOP_LOSS_TRIGGERED",
            category: "risk",
            symbol: event.config.symbol,
            message: `Stop-loss triggered: ${event.config.symbol} at ₹${event.triggerPrice} (stop: ₹${event.config.stopLossPrice})`,
            details: {
                stopLossPrice: event.config.stopLossPrice,
                triggerPrice: event.triggerPrice,
            },
            severity: "warn",
        });
    }

    /**
     * Log stop-loss executed
     */
    async logStopLossExecuted(event: { config: { symbol: string }; execution: unknown }): Promise<void> {
        await this.log({
            eventType: "STOP_LOSS_EXECUTED",
            category: "risk",
            symbol: event.config.symbol,
            message: `Stop-loss order executed for ${event.config.symbol}`,
            details: { execution: event.execution },
            severity: "warn",
        });
    }

    /**
     * Log stop-loss creation
     */
    async logStopLossCreated(symbol: string, stopLossPrice: number, type: string): Promise<void> {
        await this.log({
            eventType: "STOP_LOSS_CREATED",
            category: "risk",
            symbol,
            message: `Stop-loss created: ${symbol} at ₹${stopLossPrice} (${type})`,
            details: { stopLossPrice, type },
            severity: "info",
        });
    }

    /**
     * Log settings change
     */
    async logSettingsChanged(limits: RiskLimits): Promise<void> {
        await this.log({
            eventType: "SETTINGS_CHANGED",
            category: "system",
            message: "Risk settings updated",
            details: limits as unknown as Record<string, unknown>,
            severity: "info",
        });
    }

    /**
     * Log circuit breaker triggered
     */
    async logCircuitBreaker(reason: string, details?: Record<string, unknown>): Promise<void> {
        await this.log({
            eventType: "CIRCUIT_BREAKER_TRIGGERED",
            category: "risk",
            message: `Circuit breaker activated: ${reason}`,
            details,
            severity: "error",
        });
    }

    /**
     * Log trading loop started
     */
    async logTradingStarted(): Promise<void> {
        await this.log({
            eventType: "TRADING_STARTED",
            category: "system",
            message: "Trading loop started",
            severity: "info",
        });
    }

    /**
     * Log trading loop stopped
     */
    async logTradingStopped(): Promise<void> {
        await this.log({
            eventType: "TRADING_STOPPED",
            category: "system",
            message: "Trading loop stopped",
            severity: "info",
        });
    }

    /**
     * Log panic sell
     */
    async logPanicSell(executedCount: number, failedCount: number): Promise<void> {
        await this.log({
            eventType: "PANIC_SELL",
            category: "system",
            message: `PANIC SELL executed: ${executedCount} sold, ${failedCount} failed`,
            details: { executedCount, failedCount },
            severity: "warn",
        });
    }

    /**
     * Log strategy signal
     */
    async logStrategySignal(strategyId: string, description: string, symbol?: string): Promise<void> {
        await this.log({
            eventType: "STRATEGY_SIGNAL",
            category: "strategy",
            symbol,
            message: `[${strategyId}] ${description}`,
            details: { strategyId, description },
            severity: "info",
        });
    }

    /**
     * Log reconciliation event
     */
    async logReconciliation(hasDiscrepancies: boolean, details?: Record<string, unknown>): Promise<void> {
        await this.log({
            eventType: "RECONCILIATION",
            category: "system",
            message: hasDiscrepancies ? "Reconciliation found discrepancies" : "Reconciliation complete - synced",
            details,
            severity: hasDiscrepancies ? "warn" : "info",
        });
    }

    /**
     * Generic log method
     */
    async log(entry: Omit<AuditLogEntry, "id" | "timestamp">): Promise<void> {
        const fullEntry: AuditLogEntry = {
            id: randomUUID(),
            timestamp: new Date(),
            ...entry,
        };

        try {
            await this.repository.append(fullEntry);
            logger.debug({ eventType: entry.eventType, symbol: entry.symbol }, "Audit log entry created");
        } catch (error) {
            logger.error({ err: error, entry }, "Failed to write audit log entry");
        }
    }

    /**
     * Query audit logs
     */
    async query(queryParams: AuditLogQuery): Promise<AuditLogEntry[]> {
        return this.repository.query(queryParams);
    }

    /**
     * Get today's audit logs
     */
    async getToday(): Promise<AuditLogEntry[]> {
        return this.repository.getToday();
    }

    /**
     * Get stats by event type
     */
    async getStats(): Promise<Record<AuditEventType, number>> {
        return this.repository.getStats();
    }

    /**
     * Cleanup old logs (retention policy)
     */
    async cleanup(retentionDays: number = 30): Promise<number> {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - retentionDays);
        return this.repository.cleanup(cutoff);
    }
}

export default AuditLogService;
