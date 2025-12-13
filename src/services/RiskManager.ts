import { EventEmitter } from "events";

import type { SettingsRepository } from "../persistence/SettingsRepository"; // Will create this next
import type { BrokerOrderExecution, BrokerOrderRequest } from "../types";
import logger from "../utils/logger";

export interface RiskLimits {
    maxDailyLoss: number;
    maxDailyLossPercent: number;
    maxPositionSize: number;
    maxOpenPositions: number;
    stopLossPercent: number;
    circuitBroken?: boolean;
}

export interface RiskCheckResult {
    allowed: boolean;
    reason?: string;
}

export class RiskManager extends EventEmitter {
    private dailyRealizedPnL = 0;
    private dailyUnrealizedPnL = 0;
    private circuitBroken = false;
    private executionCount = 0;
    private processingLock = false; // Simple mutex for state updates

    // Cache limits in memory
    private limits: RiskLimits;

    constructor(private readonly settingsRepo: SettingsRepository) {
        super();
        this.limits = this.settingsRepo.getRiskLimits();
        this.circuitBroken = !!this.limits.circuitBroken;

        // Listen for setting changes
        this.settingsRepo.on('updated', (newLimits: RiskLimits) => {
            this.limits = newLimits;
            // Update local state if config changed externally
            if (newLimits.circuitBroken !== undefined) {
                this.circuitBroken = newLimits.circuitBroken;
            }
            logger.info({ newLimits }, "Risk limits updated in RiskManager");
        });
    }

    public checkOrderAllowed(order: BrokerOrderRequest, currentUnrealizedPnL: number, openPositionsCount: number): RiskCheckResult {
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
        // If it's a BUY order (assuming long-only for now or that BUY opens positions)
        // And we're currently at or above the limit
        if (order.quantity > 0 && order.side === "BUY" && openPositionsCount >= this.limits.maxOpenPositions) {
            return { allowed: false, reason: `Max open positions limit reached: ${openPositionsCount} >= ${this.limits.maxOpenPositions}` };
        }

        // 4. Check Position Size
        const estimatedValue = order.quantity * (order.price || 0); // Price might be missing for market orders
        // If market order, we might skip this or use last price
        if (estimatedValue > this.limits.maxPositionSize) {
            return { allowed: false, reason: `Order value ${estimatedValue} exceeds max position size ${this.limits.maxPositionSize}` };
        }

        return { allowed: true };
    }

    public recordExecution(_execution: BrokerOrderExecution) {
        this.executionCount++;
        // Update daily PnL logic here if we have PnL data in execution (usually we don't till close)
        // We rely on PortfolioService for accurate PnL, this is for quick intra-day tracking if possible
    }

    // Update PnL from PortfolioService
    public updatePnL(realized: number, unrealized: number) {
        if (this.processingLock) {
            logger.warn("RiskManager locked, skipping PnL update");
            return;
        }

        this.processingLock = true;
        try {
            this.dailyRealizedPnL = realized;
            this.dailyUnrealizedPnL = unrealized;

            const total = realized + unrealized;
            if (total <= -this.limits.maxDailyLoss && !this.circuitBroken) {
                this.triggerCircuitBreaker(`Daily loss limit hit via PnL update: ${total}`);
            }
        } finally {
            this.processingLock = false;
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
        this.processingLock = false;

        // Persist reset state
        this.limits.circuitBroken = false;
        this.settingsRepo.saveRiskLimits(this.limits).catch(err => {
            logger.error({ err }, "Failed to persist circuit breaker reset");
        });

        logger.info("Daily risk counters reset");
    }

    private triggerCircuitBreaker(reason: string) {
        this.circuitBroken = true;

        // Persist broken state
        this.limits.circuitBroken = true;
        this.settingsRepo.saveRiskLimits(this.limits).catch(err => {
            logger.error({ err }, "Failed to persist circuit breaker state");
        });

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
