import { EventEmitter } from "events";

import type { SettingsRepo } from "../db/repositories/SettingsRepo";
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

export interface UserRiskState {
    dailyRealizedPnL: number;
    dailyUnrealizedPnL: number;
    circuitBroken: boolean;
    executionCount: number;
    limits: RiskLimits;
}

export class RiskManager extends EventEmitter {
    private userStates = new Map<string, UserRiskState>();
    private processingLock = Promise.resolve(); // Async mutex for state updates

    constructor(private readonly settingsRepo: SettingsRepo) {
        super();

        // Listen for setting changes
        this.settingsRepo.on('updated', (userId: string, newLimits: RiskLimits) => {
            const state = this.getUserState(userId);
            state.limits = newLimits;
            // Update local state if config changed externally
            if (newLimits.circuitBroken !== undefined) {
                state.circuitBroken = newLimits.circuitBroken;
            }
            logger.info({ userId, newLimits }, "Risk limits updated in RiskManager");
        });
    }

    private getUserState(userId: string): UserRiskState {
        let state = this.userStates.get(userId);
        if (!state) {
            const limits = this.settingsRepo.getRiskLimits(userId);
            state = {
                dailyRealizedPnL: 0,
                dailyUnrealizedPnL: 0,
                circuitBroken: !!limits.circuitBroken,
                executionCount: 0,
                limits,
            };
            this.userStates.set(userId, state);
        }
        return state;
    }

    public checkOrderAllowed(userId: string, order: BrokerOrderRequest, currentUnrealizedPnL: number, openPositionsCount: number): RiskCheckResult {
        const state = this.getUserState(userId);
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
        if (state.circuitBroken && !isEmergency) {
            return { allowed: false, reason: "Circuit breaker active - trading halted for user" };
        }

        // 2. Check Daily Loss Limit (Realized + Unrealized)
        const totalDailyPnL = state.dailyRealizedPnL + currentUnrealizedPnL;
        if (totalDailyPnL <= -state.limits.maxDailyLoss && !isEmergency) {
            this.triggerCircuitBreaker(userId, `Daily loss limit hit: ${totalDailyPnL} <= -${state.limits.maxDailyLoss}`);
            return { allowed: false, reason: "Daily loss limit exceeded" };
        }

        // 3. Check Max Open Positions (only for new entry orders)
        if (order.quantity > 0 && order.side === "BUY" && openPositionsCount >= state.limits.maxOpenPositions && !isEmergency) {
            return { allowed: false, reason: `Max open positions limit reached: ${openPositionsCount} >= ${state.limits.maxOpenPositions}` };
        }

        // 4. Check Position Size
        if (order.type !== "MARKET" && !isEmergency) {
            const estimatedValue = order.quantity * (order.price || 0);
            if (estimatedValue > state.limits.maxPositionSize) {
                return { allowed: false, reason: `Order value ${estimatedValue} exceeds max position size ${state.limits.maxPositionSize}` };
            }
        } else if (order.type === "MARKET" && !isEmergency) {
            // implicit pass for market orders
        }

        return { allowed: true };
    }

    public recordExecution(userId: string, _execution: BrokerOrderExecution) {
        const state = this.getUserState(userId);
        state.executionCount++;
    }

    // Update PnL from PortfolioService
    public async updatePnL(userId: string, realized: number, unrealized: number) {
        // Queue updates via promise chain
        this.processingLock = this.processingLock.then(async () => {
            try {
                const state = this.getUserState(userId);
                state.dailyRealizedPnL = realized;
                state.dailyUnrealizedPnL = unrealized;

                const total = realized + unrealized;
                if (total <= -state.limits.maxDailyLoss && !state.circuitBroken) {
                    this.triggerCircuitBreaker(userId, `Daily loss limit hit via PnL update: ${total}`);
                }
            } catch (error) {
                logger.error({ err: error, userId }, "Error updating PnL in RiskManager");
            }
        });

        await this.processingLock;
    }

    public isCircuitBroken(userId: string): boolean {
        return this.getUserState(userId).circuitBroken;
    }

    public async resetDailyCounters(userId: string) {
        const state = this.getUserState(userId);
        state.dailyRealizedPnL = 0;
        state.dailyUnrealizedPnL = 0;
        state.circuitBroken = false;
        state.executionCount = 0;

        // Persist reset state
        state.limits.circuitBroken = false;
        try {
            await this.settingsRepo.saveRiskLimits(userId, state.limits);
            logger.info({ userId }, "Daily risk counters reset");
        } catch (err) {
            logger.error({ err, userId }, "CRITICAL: Failed to persist circuit breaker reset");
            // We proceed but log critical error
        }
    }

    private triggerCircuitBreaker(userId: string, reason: string) {
        const state = this.getUserState(userId);
        state.circuitBroken = true;

        // Persist broken state
        state.limits.circuitBroken = true;
        this.settingsRepo.saveRiskLimits(userId, state.limits).catch((err: Error) => {
            logger.error({ err, userId }, "CRITICAL: Failed to persist circuit breaker state");
            this.emit("critical_error", { type: "persistence_failure", error: err, userId });
        });

        logger.error({ reason, userId }, "CIRCUIT BREAKER TRIGGERED - TRADING HALTED FOR USER");
        this.emit("circuit_break", { reason, userId });
    }

    public getStatus(userId: string) {
        const state = this.getUserState(userId);
        return {
            circuitBroken: state.circuitBroken,
            dailyPnL: state.dailyRealizedPnL + state.dailyUnrealizedPnL,
            limits: state.limits
        };
    }
}
