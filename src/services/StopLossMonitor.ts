import { EventEmitter } from "events";
import type { MarketTick, BrokerOrderRequest, Trade } from "../types";
import type MarketDataService from "./MarketDataService";
import type TradingEngine from "./TradingEngine";
import type { StopLossConfig, StopLossRepository } from "../persistence/StopLossRepository";
import type { RiskManager } from "./RiskManager";
import logger from "../utils/logger";

export interface StopLossMonitorOptions {
    marketDataService: MarketDataService;
    tradingEngine: TradingEngine;
    stopLossRepository: StopLossRepository;
    riskManager: RiskManager;
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
    private readonly repository: StopLossRepository;
    private readonly riskManager: RiskManager;
    private readonly processingSymbols = new Set<string>();
    private readonly symbolQueues = new Map<string, Promise<void>>();

    private isMonitoring = false;
    private static instance: StopLossMonitor | null = null;
    private readonly DEFAULT_TRAILING_PERCENT = 3;

    constructor(options: StopLossMonitorOptions) {
        super();
        this.marketDataService = options.marketDataService;
        this.tradingEngine = options.tradingEngine;
        this.repository = options.stopLossRepository;
        this.riskManager = options.riskManager;

        // Listen to trade events for automatic stop-loss management
        this.tradingEngine.on("trade-executed", this.handleTradeExecuted);
    }

    /**
     * Handle trade execution - auto-create or update stop-losses
     * Uses promise-chaining queue per symbol to ensure trades are processed
     * in order without dropping any updates.
     */
    private handleTradeExecuted = async (trade: Trade): Promise<void> => {
        const existing = this.symbolQueues.get(trade.symbol) ?? Promise.resolve();
        const next = existing
            .then(() => this.processTradeUpdate(trade))
            .catch(err => {
                logger.error({ err, trade }, "Failed to process trade for stop-loss");
            })
            .finally(() => {
                // Clean up if this is still the current promise (prevents memory leak)
                if (this.symbolQueues.get(trade.symbol) === next) {
                    this.symbolQueues.delete(trade.symbol);
                }
            });
        this.symbolQueues.set(trade.symbol, next);
        await next;
    };

    /**
     * Process a single trade update (called within queue)
     */
    private async processTradeUpdate(trade: Trade): Promise<void> {
        if (trade.side === "BUY") {
            await this.onPositionOpened(trade);
        } else {
            await this.onPositionReduced(trade);
        }
    }

    static getInstance(options?: StopLossMonitorOptions): StopLossMonitor {
        if (!StopLossMonitor.instance) {
            if (!options) {
                throw new Error("StopLossMonitor not initialized");
            }
            StopLossMonitor.instance = new StopLossMonitor(options);
        }
        return StopLossMonitor.instance;
    }

    /**
     * Start monitoring for stop-losses
     */
    start(): void {
        if (this.isMonitoring) {
            logger.info("StopLossMonitor already running");
            return;
        }

        this.isMonitoring = true;
        this.marketDataService.on("tick", this.handleTick);
        logger.info("StopLossMonitor started");
    }

    /**
     * Stop monitoring
     */
    stop(): void {
        if (!this.isMonitoring) return;

        this.isMonitoring = false;
        this.marketDataService.off("tick", this.handleTick);
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
    getAll(): StopLossConfig[] {
        return this.repository.getAll();
    }

    /**
     * Get stop-loss for a specific symbol
     */
    get(symbol: string): StopLossConfig | undefined {
        return this.repository.get(symbol);
    }

    /**
     * Create or update a stop-loss for a position
     */
    async setStopLoss(
        symbol: string,
        options: {
            entryPrice: number;
            quantity: number;
            stopLossPrice?: number;
            type?: "FIXED" | "TRAILING";
            trailingPercent?: number;
        }
    ): Promise<StopLossConfig> {
        const riskLimits = this.riskManager.getStatus().limits;
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
    async removeStopLoss(symbol: string): Promise<void> {
        await this.repository.delete(symbol);
    }

    /**
     * Auto-create stop-loss when a position is opened
     * Called by TradingEngine after trade execution
     */
    async onPositionOpened(trade: Trade): Promise<void> {
        if (trade.side !== "BUY") {
            // Only set stop-loss for LONG positions (BUY entries)
            // For SHORT positions, we'd need a stop-loss above entry (future enhancement)
            return;
        }

        // Check if we already have a stop-loss for this symbol
        const existing = this.repository.get(trade.symbol);
        if (existing) {
            // Update quantity if adding to position
            const newQuantity = existing.quantity + trade.quantity;
            // Recalculate average entry price
            const totalCost = (existing.entryPrice * existing.quantity) + (trade.price * trade.quantity);
            const newEntryPrice = totalCost / newQuantity;

            await this.setStopLoss(trade.symbol, {
                entryPrice: newEntryPrice,
                quantity: newQuantity,
                type: existing.type,
                trailingPercent: existing.trailingPercent,
            });
        } else {
            // Create new stop-loss
            await this.setStopLoss(trade.symbol, {
                entryPrice: trade.price,
                quantity: trade.quantity,
            });
        }
    }

    /**
     * Adjust stop-loss when a position is reduced
     */
    async onPositionReduced(trade: Trade): Promise<void> {
        if (trade.side !== "SELL") return;

        const existing = this.repository.get(trade.symbol);
        if (!existing) return;

        const newQuantity = existing.quantity - trade.quantity;

        if (newQuantity <= 0) {
            // Position fully closed - remove stop-loss
            await this.removeStopLoss(trade.symbol);
        } else {
            // Update quantity
            existing.quantity = newQuantity;
            existing.updatedAt = new Date();
            await this.repository.save(existing);
        }
    }

    /**
     * Handle incoming market tick
     */
    private handleTick = async (tick: MarketTick): Promise<void> => {
        // Prevent concurrent processing for the same symbol (race condition fix)
        if (this.processingSymbols.has(tick.symbol)) {
            return;
        }

        const config = this.repository.get(tick.symbol);
        if (!config) return;

        this.processingSymbols.add(tick.symbol);

        try {
            // Check for trailing stop update
            let currentConfig = config;

            if (currentConfig.type === "TRAILING" && tick.price > (currentConfig.highWaterMark ?? currentConfig.entryPrice)) {
                await this.updateTrailingStop(currentConfig, tick.price);
                // Refresh config after update to check breach against NEW stop loss price
                const updated = this.repository.get(tick.symbol);
                if (updated) {
                    currentConfig = updated;
                }
            }

            // Check if stop-loss is breached
            if (tick.price <= currentConfig.stopLossPrice) {
                // Pass true to skip lock check because we already hold the lock
                await this.executeStopLoss(currentConfig, tick, true);
            }
        } catch (error) {
            logger.error({ err: error, symbol: tick.symbol }, "Error processing stop-loss tick");
        } finally {
            this.processingSymbols.delete(tick.symbol);
        }
    };

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

        // Check if already processing this symbol to avoid double execution
        if (!skipLockCheck && this.processingSymbols.has(config.symbol)) {
            logger.warn({ symbol: config.symbol }, "Already processing stop-loss for symbol, skipping");
            return;
        }

        if (!skipLockCheck) {
            this.processingSymbols.add(config.symbol);
        }

        try {
            // Execute via TradingEngine (bypasses normal risk checks for emergency exit)
            const signal = {
                strategyId: "stop-loss-monitor",
                description: `Stop-loss triggered at ${tick.price} (stop: ${config.stopLossPrice})`,
                requestedOrders: [order],
            };

            const result = await this.tradingEngine.executeSignal(
                this.tradingEngine.getActiveBroker(),
                signal
            );

            if (result.executions.length > 0) {
                logger.info(
                    { symbol: config.symbol, execution: result.executions[0] },
                    "Stop-loss order executed successfully"
                );

                // Remove the stop-loss after successful execution
                await this.repository.delete(config.symbol);

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
        } finally {
            if (!skipLockCheck) {
                this.processingSymbols.delete(config.symbol);
            }
        }
    }

    /**
     * Get status summary
     */
    getStatus(): {
        monitoring: boolean;
        activeStopLosses: number;
        stopLosses: StopLossConfig[];
    } {
        const stopLosses = this.repository.getAll();
        return {
            monitoring: this.isMonitoring,
            activeStopLosses: stopLosses.length,
            stopLosses,
        };
    }
}

export default StopLossMonitor;
