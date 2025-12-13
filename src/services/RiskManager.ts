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
    private processingLock = Promise.resolve(); // Async mutex for state updates

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

        // 5. Bypass checks for Emergency Exits
        const isEmergency = order.tag?.startsWith("STOP-LOSS") || order.tag?.startsWith("PANIC-SELL");

        // 1. Check Circuit Breaker
        if (this.circuitBroken && !isEmergency) {
            return { allowed: false, reason: "Circuit breaker active - trading halted" };
        }

        // 2. Check Daily Loss Limit (Realized + Unrealized)
        const totalDailyPnL = this.dailyRealizedPnL + currentUnrealizedPnL;
        if (totalDailyPnL <= -this.limits.maxDailyLoss && !isEmergency) {
            this.triggerCircuitBreaker(`Daily loss limit hit: ${totalDailyPnL} <= -${this.limits.maxDailyLoss}`);
            return { allowed: false, reason: "Daily loss limit exceeded" };
        }

        // 3. Check Max Open Positions (only for new entry orders)
        // If it's a BUY order (assuming long-only for now or that BUY opens positions)
        // And we're currently at or above the limit
        if (order.quantity > 0 && order.side === "BUY" && openPositionsCount >= this.limits.maxOpenPositions && !isEmergency) {
            return { allowed: false, reason: `Max open positions limit reached: ${openPositionsCount} >= ${this.limits.maxOpenPositions}` };
        }

        // 4. Check Position Size
        // Skip for MARKET orders since price is unknown (0), or emergency orders
        if (order.type !== "MARKET" && !isEmergency) {
            const estimatedValue = order.quantity * (order.price || 0);
            if (estimatedValue > this.limits.maxPositionSize) {
                return { allowed: false, reason: `Order value ${estimatedValue} exceeds max position size ${this.limits.maxPositionSize}` };
            }
        } else if (order.type === "MARKET" && !isEmergency) {
            // Optional: warns or rough check if we had current price
            // For now, implicit pass for market orders on size check, or we could require currentPrice passed in
        }

        return { allowed: true };
    }

    public recordExecution(_execution: BrokerOrderExecution) {
        this.executionCount++;
        // Update daily PnL logic here if we have PnL data in execution (usually we don't till close)
        // We rely on PortfolioService for accurate PnL, this is for quick intra-day tracking if possible
    }

    // Update PnL from PortfolioService
    public async updatePnL(realized: number, unrealized: number) {
        // Queue updates via promise chain
        this.processingLock = this.processingLock.then(async () => {
            try {
                this.dailyRealizedPnL = realized;
                this.dailyUnrealizedPnL = unrealized;

                const total = realized + unrealized;
                if (total <= -this.limits.maxDailyLoss && !this.circuitBroken) {
                    this.triggerCircuitBreaker(`Daily loss limit hit via PnL update: ${total}`);
                }
            } catch (error) {
                logger.error({ err: error }, "Error updating PnL in RiskManager");
            }
        });

        await this.processingLock;
    }

    public isCircuitBroken(): boolean {
        return this.circuitBroken;
    }

    public async resetDailyCounters() {
        this.dailyRealizedPnL = 0;
        this.dailyUnrealizedPnL = 0;
        this.circuitBroken = false;
        this.executionCount = 0;

        // Persist reset state
        this.limits.circuitBroken = false;
        try {
            await this.settingsRepo.saveRiskLimits(this.limits);
            logger.info("Daily risk counters reset");
        } catch (err) {
            logger.error({ err }, "CRITICAL: Failed to persist circuit breaker reset");
            // We proceed but log critical error
        }
    }

    private triggerCircuitBreaker(reason: string) {
        this.circuitBroken = true;

        // Persist broken state
        this.limits.circuitBroken = true;
        this.settingsRepo.saveRiskLimits(this.limits).catch(err => {
            logger.error({ err }, "CRITICAL: Failed to persist circuit breaker state");
            this.emit("critical_error", { type: "persistence_failure", error: err });
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
