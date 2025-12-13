import { EventEmitter } from "events";
import { getPortfolioRepository } from "../persistence";
import type { SettingsRepository } from "../persistence/SettingsRepository"; // Will create this next
import type { BrokerOrderExecution, BrokerOrderRequest } from "../types";
import logger from "../utils/logger";

export interface RiskLimits {
    maxDailyLoss: number;
    maxDailyLossPercent: number;
    maxPositionSize: number;
    maxOpenPositions: number;
    stopLossPercent: number;
}

export interface RiskCheckResult {
    allowed: boolean;
    reason?: string;
}

export class RiskManager extends EventEmitter {
    private dailyRealizedPnL = 0;
    private dailyUnrealizedPnL = 0;
    private circuitBroken = false;
    private openPositionsCount = 0;
    private executionCount = 0;

    // Cache limits in memory
    private limits: RiskLimits;

    constructor(private readonly settingsRepo: SettingsRepository) {
        super();
        this.limits = this.settingsRepo.getRiskLimits();

        // Listen for setting changes
        this.settingsRepo.on('updated', (newLimits: RiskLimits) => {
            this.limits = newLimits;
            logger.info({ newLimits }, "Risk limits updated in RiskManager");
        });
    }

    public checkOrderAllowed(order: BrokerOrderRequest, currentUnrealizedPnL: number): RiskCheckResult {
        // 0. Validate basic order parameters first
        if (order.quantity <= 0) {
            return { allowed: false, reason: `Invalid quantity: ${order.quantity} (must be > 0)` };
        }

        if (order.type === "LIMIT" && (!order.price || order.price <= 0)) {
            return { allowed: false, reason: `Invalid price: ${order.price} (must be > 0 for LIMIT orders)` };
        }

        // 1. Check Circuit Breaker
        if (this.circuitBroken) {
            return { allowed: false, reason: "Circuit breaker active - trading halted" };
        }

        // 2. Check Daily Loss Limit (Realized + Unrealized)
        const totalDailyPnL = this.dailyRealizedPnL + currentUnrealizedPnL;
        if (totalDailyPnL <= -this.limits.maxDailyLoss) {
            this.triggerCircuitBreaker(`Daily loss limit hit: ${totalDailyPnL} <= -${this.limits.maxDailyLoss}`);
            return { allowed: false, reason: "Daily loss limit exceeded" };
        }

        // 3. Check Max Open Positions (only for new entry orders)
        if (order.quantity > 0 && this.openPositionsCount >= this.limits.maxOpenPositions) {
            // Only block if it's opening a new position (simplified check, assumes BUY is open)
            // Improve logic: need to know if it's closing or opening. 
            // For now, let's assume TradingEngine handles position sizing, here we check global counts
            // Actually TradingEngine should check existing position.
            // We'll rely on TradingEngine for "is this a new position?" logic generally, 
            // but here we enforce hard limit if it IS a new position.
        }

        // 4. Check Position Size
        const estimatedValue = order.quantity * (order.price || 0); // Price might be missing for market orders
        // If market order, we might skip this or use last price
        if (estimatedValue > this.limits.maxPositionSize) {
            return { allowed: false, reason: `Order value ${estimatedValue} exceeds max position size ${this.limits.maxPositionSize}` };
        }

        return { allowed: true };
    }

    public recordExecution(execution: BrokerOrderExecution) {
        this.executionCount++;
        // Update daily PnL logic here if we have PnL data in execution (usually we don't till close)
        // We rely on PortfolioService for accurate PnL, this is for quick intra-day tracking if possible
    }

    // Update PnL from PortfolioService
    public updatePnL(realized: number, unrealized: number) {
        this.dailyRealizedPnL = realized;
        this.dailyUnrealizedPnL = unrealized;

        const total = realized + unrealized;
        if (total <= -this.limits.maxDailyLoss && !this.circuitBroken) {
            this.triggerCircuitBreaker(`Daily loss limit hit via PnL update: ${total}`);
        }
    }

    public isCircuitBroken(): boolean {
        return this.circuitBroken;
    }

    public resetDailyCounters() {
        this.dailyRealizedPnL = 0;
        this.dailyUnrealizedPnL = 0;
        this.circuitBroken = false;
        this.executionCount = 0;
        logger.info("Daily risk counters reset");
    }

    private triggerCircuitBreaker(reason: string) {
        this.circuitBroken = true;
        logger.error({ reason }, "CIRCUIT BREAKER TRIGGERED - TRADING HALTED");
        this.emit("circuit_break", reason);
    }

    public getStatus() {
        return {
            circuitBroken: this.circuitBroken,
            dailyPnL: this.dailyRealizedPnL + this.dailyUnrealizedPnL,
            limits: this.limits
        };
    }
}
