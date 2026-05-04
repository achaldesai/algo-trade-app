import { EventEmitter } from "events";
import type { MarketTick, BrokerOrderRequest, Trade } from "../types";
import type BrokerClient from "../brokers/BrokerClient";
import type MarketDataService from "./MarketDataService";
import type TradingEngine from "./TradingEngine";
import type { StopLossConfig } from "../db/repositories/StopLossRepo";
import type { StopLossRepo } from "../db/repositories/StopLossRepo";
import type { RiskManager } from "./RiskManager";
import logger from "../utils/logger";
import env from "../config/env";

export interface StopLossMonitorOptions {
    marketDataService: MarketDataService;
    tradingEngine: TradingEngine;
    stopLossRepository: StopLossRepo;
    riskManager: RiskManager;
    brokerFactory?: (userId: string) => Promise<BrokerClient>;
}

export interface StopLossTriggeredEvent {
    config: StopLossConfig;
    triggerPrice: number;
    triggerTime: Date;
}

/**
 * StopLossMonitor - Monitors market ticks and executes stop-loss orders
 * 
 * Responsibilities:
 * - Subscribe to MarketDataService tick events
 * - Check each tick against active stop-losses
 * - Execute MARKET SELL orders when stop-loss is breached
 * - Support trailing stop-loss (updates high water mark on price increase)
 * - Auto-create stop-losses when positions are opened
 */
export class StopLossMonitor extends EventEmitter {
    private readonly marketDataService: MarketDataService;
    private readonly tradingEngine: TradingEngine;
    private readonly repository: StopLossRepo;
    private readonly riskManager: RiskManager;
    private readonly brokerFactory?: (userId: string) => Promise<BrokerClient>;
    private readonly symbolQueues = new Map<string, Promise<void>>();
    private readonly tickQueues = new Map<string, Promise<void>>();

    private isMonitoring = false;
    private readonly DEFAULT_TRAILING_PERCENT = env.defaultTrailingStopPercent;

    constructor(options: StopLossMonitorOptions) {
        super();
        this.marketDataService = options.marketDataService;
        this.tradingEngine = options.tradingEngine;
        this.repository = options.stopLossRepository;
        this.riskManager = options.riskManager;
        this.brokerFactory = options.brokerFactory;

        // Listen to trade events for automatic stop-loss management
        this.tradingEngine.on("trade-executed", this.handleTradeExecuted);
    }

    /**
     * Handle trade execution - auto-create or update stop-losses
     * Uses promise-chaining queue per symbol to ensure trades are processed
     * in order without dropping any updates.
     */
    private handleTradeExecuted = async (data: { trade: Trade, userId: string }): Promise<void> => {
        const { trade, userId } = data;
        const queueKey = `${userId}:${trade.symbol}`;
        const existing = this.symbolQueues.get(queueKey) ?? Promise.resolve();
        const next = existing
            .then(() => this.processTradeUpdate(userId, trade))
            .catch(err => {
                logger.error({ err, trade, userId }, "Failed to process trade for stop-loss");
            })
            .finally(() => {
                // Clean up if this is still the current promise (prevents memory leak)
                if (this.symbolQueues.get(queueKey) === next) {
                    this.symbolQueues.delete(queueKey);
                }
            });
        this.symbolQueues.set(queueKey, next);
        await next;
    };

    /**
     * Process a single trade update (called within queue)
     */
    private async processTradeUpdate(userId: string, trade: Trade): Promise<void> {
        if (trade.side === "BUY") {
            await this.onPositionOpened(userId, trade);
        } else {
            await this.onPositionReduced(userId, trade);
        }
    }

    /**
     * Start monitoring
     */
    start(): void {
        if (this.isMonitoring) {
            logger.info("StopLossMonitor already running");
            return;
        }

        this.isMonitoring = true;
        this.marketDataService.on("tick", this.handleTick);
        this.tradingEngine.on("trade-executed", this.handleTradeExecuted);
        logger.info("StopLossMonitor started");
    }

    /**
     * Stop monitoring
     */
    stop(): void {
        if (!this.isMonitoring) return;

        this.isMonitoring = false;
        this.marketDataService.off("tick", this.handleTick);
        this.tradingEngine.off("trade-executed", this.handleTradeExecuted);
        logger.info("StopLossMonitor stopped");
    }

    /**
     * Check if monitoring is active
     */
    isRunning(): boolean {
        return this.isMonitoring;
    }

    /**
     * Get all active stop-losses
     */
    getAll(userId?: string): StopLossConfig[] {
        // Simple fallback until repository has a get-all-without-userid method, 
        // normally we should be scoping these by user anyway.
        if (userId) return this.repository.getAll(userId);
        return []; // Getting all for ALL users via this method is likely unwanted
    }

    /**
     * Get stop-loss for a specific symbol
     */
    get(userId: string, symbol: string): StopLossConfig | undefined {
        return this.repository.get(userId, symbol);
    }

    /**
     * Create or update a stop-loss for a position
     */
    async setStopLoss(
        userId: string,
        symbol: string,
        options: {
            entryPrice: number;
            quantity: number;
            stopLossPrice?: number;
            type?: "FIXED" | "TRAILING";
            trailingPercent?: number;
        }
    ): Promise<StopLossConfig> {
        const riskLimits = this.riskManager.getStatus(userId).limits;
        const defaultStopLossPercent = riskLimits.stopLossPercent;

        const type = options.type ?? "FIXED";
        const trailingPercent = options.trailingPercent ?? defaultStopLossPercent;

        // Calculate stop-loss price
        let stopLossPrice: number;
        if (options.stopLossPrice !== undefined) {
            stopLossPrice = options.stopLossPrice;
        } else {
            // Default: entry price - stopLossPercent%
            stopLossPrice = options.entryPrice * (1 - defaultStopLossPercent / 100);
        }

        const config: StopLossConfig = {
            symbol: symbol.toUpperCase(),
            userId,
            entryPrice: options.entryPrice,
            stopLossPrice: Number(stopLossPrice.toFixed(2)),
            quantity: options.quantity,
            type,
            trailingPercent: type === "TRAILING" ? trailingPercent : undefined,
            highWaterMark: type === "TRAILING" ? options.entryPrice : undefined,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        await this.repository.save(config);

        logger.info(
            { symbol: config.symbol, entryPrice: config.entryPrice, stopLossPrice: config.stopLossPrice, type },
            "Stop-loss set"
        );

        return config;
    }

    /**
     * Remove stop-loss for a symbol
     */
    async removeStopLoss(userId: string, symbol: string): Promise<void> {
        await this.repository.delete(userId, symbol);
    }

    /**
     * Auto-create stop-loss when a position is opened
     * Called by TradingEngine after trade execution
     */
    async onPositionOpened(userId: string, trade: Trade): Promise<void> {
        if (trade.side !== "BUY") {
            // Only set stop-loss for LONG positions (BUY entries)
            // For SHORT positions, we'd need a stop-loss above entry (future enhancement)
            return;
        }

        // Check if we already have a stop-loss for this symbol
        const existing = this.repository.get(userId, trade.symbol);
        if (existing) {
            // Update quantity if adding to position
            const newQuantity = existing.quantity + trade.quantity;
            // Recalculate average entry price
            const totalCost = (existing.entryPrice * existing.quantity) + (trade.price * trade.quantity);
            const newEntryPrice = totalCost / newQuantity;

            await this.setStopLoss(userId, trade.symbol, {
                entryPrice: newEntryPrice,
                quantity: newQuantity,
                type: existing.type,
                trailingPercent: existing.trailingPercent,
            });
        } else {
            // Create new stop-loss
            await this.setStopLoss(userId, trade.symbol, {
                entryPrice: trade.price,
                quantity: trade.quantity,
            });
        }
    }

    /**
     * Adjust stop-loss when a position is reduced
     */
    async onPositionReduced(userId: string, trade: Trade): Promise<void> {
        if (trade.side !== "SELL") return;

        const existing = this.repository.get(userId, trade.symbol);
        if (!existing) return;

        const newQuantity = existing.quantity - trade.quantity;

        if (newQuantity <= 0) {
            // Position fully closed - remove stop-loss
            await this.removeStopLoss(userId, trade.symbol);
        } else {
            // Update quantity
            existing.quantity = newQuantity;
            existing.updatedAt = new Date();
            await this.repository.save(existing);
        }
    }

    /**
     * Handle incoming market tick
     * Uses promise-queue pattern to process ticks in order without dropping any.
     */
    private handleTick = async (tick: MarketTick): Promise<void> => {
        const existing = this.tickQueues.get(tick.symbol) ?? Promise.resolve();
        const next = existing
            .then(() => this.processTickForSymbol(tick))
            .catch(err => {
                logger.error({ err, symbol: tick.symbol }, "Error processing stop-loss tick");
            })
            .finally(() => {
                // Clean up if this is still the current promise (prevents memory leak)
                if (this.tickQueues.get(tick.symbol) === next) {
                    this.tickQueues.delete(tick.symbol);
                }
            });
        this.tickQueues.set(tick.symbol, next);
        await next;
    };

    /**
     * Process a single tick for stop-loss evaluation (called within queue)
     */
    private async processTickForSymbol(tick: MarketTick): Promise<void> {
        const configs = this.repository.getBySymbol(tick.symbol);
        if (configs.length === 0) return;

        for (const config of configs) {
            let currentConfig = config;

            // Check for trailing stop update
            if (currentConfig.type === "TRAILING" && tick.price > (currentConfig.highWaterMark ?? currentConfig.entryPrice)) {
                await this.updateTrailingStop(currentConfig, tick.price);
                // Refresh config after update to check breach against NEW stop loss price
                const updated = this.repository.get(config.userId, tick.symbol);
                if (!updated) {
                    logger.warn({ symbol: tick.symbol, userId: config.userId }, "Stop-loss config disappeared during trailing update");
                    continue; // use continue instead of return, other users' stop losses may remain
                }
                currentConfig = updated;
            }

            // Check if stop-loss is breached
            if (tick.price <= currentConfig.stopLossPrice) {
                // Pass true to skip lock check because queue already serializes access
                await this.executeStopLoss(currentConfig, tick, true);
            }
        }
    }

    /**
     * Update trailing stop high water mark
     */
    private async updateTrailingStop(config: StopLossConfig, currentPrice: number): Promise<void> {
        const trailingPercent = config.trailingPercent ?? this.DEFAULT_TRAILING_PERCENT;
        const newStopLossPrice = currentPrice * (1 - trailingPercent / 100);

        // Only update if the new stop-loss is higher (trailing up)
        if (newStopLossPrice > config.stopLossPrice) {
            const updated: StopLossConfig = {
                ...config,
                highWaterMark: currentPrice,
                stopLossPrice: Number(newStopLossPrice.toFixed(2)),
                updatedAt: new Date(),
            };

            await this.repository.save(updated);

            logger.debug(
                { symbol: config.symbol, newHighWaterMark: currentPrice, newStopLoss: updated.stopLossPrice },
                "Trailing stop updated"
            );
        }
    }

    /**
     * Execute stop-loss - sell the position
     */
    private async executeStopLoss(config: StopLossConfig, tick: MarketTick, skipLockCheck = false): Promise<void> {
        const event: StopLossTriggeredEvent = {
            config,
            triggerPrice: tick.price,
            triggerTime: tick.timestamp,
        };

        // Emit event before execution
        this.emit("stop-loss-triggered", event);

        logger.warn(
            {
                symbol: config.symbol,
                stopLossPrice: config.stopLossPrice,
                triggerPrice: tick.price,
                quantity: config.quantity
            },
            "🛑 STOP-LOSS TRIGGERED - Executing market sell"
        );

        // Create market sell order
        const order: BrokerOrderRequest = {
            symbol: config.symbol,
            side: "SELL",
            quantity: config.quantity,
            type: "MARKET",
            price: 0, // Market order - no price
            tag: `STOP-LOSS-${Date.now()}`,
        };

        // Note: The skipLockCheck parameter is now only used for logging; 
        // the tickQueues pattern handles serialization automatically.
        if (!skipLockCheck) {
            logger.debug({ symbol: config.symbol }, "Executing stop-loss (not called from tick queue)");
        }

        try {
            if (!this.brokerFactory) {
                throw new Error("StopLossMonitor: brokerFactory not configured");
            }
            const broker: BrokerClient = await this.brokerFactory(config.userId);

            // Execute via TradingEngine (bypasses normal risk checks for emergency exit)
            const signal = {
                strategyId: "stop-loss-monitor",
                description: `Stop-loss triggered at ${tick.price} (stop: ${config.stopLossPrice})`,
                requestedOrders: [order],
            };

            const result = await this.tradingEngine.executeSignal(
                config.userId,
                broker,
                signal
            );

            if (result.executions.length > 0) {
                logger.info(
                    { symbol: config.symbol, execution: result.executions[0] },
                    "Stop-loss order executed successfully"
                );

                // Remove the stop-loss after successful execution
                await this.repository.delete(config.userId, config.symbol);

                this.emit("stop-loss-executed", {
                    ...event,
                    execution: result.executions[0],
                });
            }

            if (result.failures.length > 0) {
                logger.error(
                    { symbol: config.symbol, failures: result.failures },
                    "Stop-loss order failed"
                );

                this.emit("stop-loss-failed", {
                    ...event,
                    failures: result.failures,
                });
            }
        } catch (error) {
            logger.error({ err: error, symbol: config.symbol }, "Failed to execute stop-loss order");
            this.emit("stop-loss-error", { ...event, error });
        }
    }

    /**
     * Get status summary
     */
    getStatus(userId?: string): {
        monitoring: boolean;
        activeStopLosses: number;
        stopLosses: StopLossConfig[];
    } {
        const stopLosses = userId ? this.repository.getAll(userId) : [];
        return {
            monitoring: this.isMonitoring,
            activeStopLosses: stopLosses.length,
            stopLosses,
        };
    }
}

export default StopLossMonitor;
