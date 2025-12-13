import type { BrokerClient } from "../brokers/BrokerClient";
import type { PortfolioService } from "./PortfolioService";
import type { Trade } from "../types";
import logger from "../utils/logger";

/**
 * Represents a discrepancy between local and broker positions
 */
export interface PositionDiscrepancy {
    symbol: string;
    localQuantity: number;
    brokerQuantity: number;
    difference: number;
    action: "SYNC_FROM_BROKER" | "MANUAL_REVIEW" | "OK";
}

/**
 * Result of a reconciliation operation
 */
export interface ReconciliationResult {
    timestamp: Date;
    hasDiscrepancies: boolean;
    discrepancies: PositionDiscrepancy[];
    brokerPositionCount: number;
    localPositionCount: number;
    syncedSymbols: string[];
}

/**
 * Service to reconcile local portfolio state with broker positions.
 * Ensures consistency between what the app thinks and what the broker has.
 */
export class ReconciliationService {
    private lastReconciliation: ReconciliationResult | null = null;
    private isReconciling = false;

    constructor(
        private readonly broker: BrokerClient,
        private readonly portfolioService: PortfolioService
    ) { }

    /**
     * Perform reconciliation on server startup.
     * Fetches broker positions and compares with local state.
     */
    async reconcileOnStartup(): Promise<ReconciliationResult> {
        logger.info("Starting position reconciliation on startup");
        return this.reconcile(true);
    }

    /**
     * Perform periodic reconciliation (non-blocking).
     */
    async reconcilePeriodic(): Promise<ReconciliationResult> {
        if (this.isReconciling) {
            logger.debug("Reconciliation already in progress, skipping");
            return this.lastReconciliation ?? this.createEmptyResult();
        }
        return this.reconcile(false);
    }

    /**
     * Core reconciliation logic
     */
    private async reconcile(isStartup: boolean): Promise<ReconciliationResult> {
        this.isReconciling = true;

        try {
            // Ensure broker is connected
            if (!this.broker.isConnected()) {
                try {
                    await this.broker.connect();
                } catch (err) {
                    logger.warn({ err }, "Could not connect to broker for reconciliation");
                    return this.createEmptyResult();
                }
            }

            // Fetch positions from broker
            let brokerPositions: Trade[] = [];
            try {
                brokerPositions = await this.broker.getPositions();
            } catch (err) {
                logger.error({ err }, "Failed to fetch broker positions for reconciliation");
                return this.createEmptyResult();
            }

            // Get local positions from PortfolioService
            const localSummaries = await this.portfolioService.getTradeSummaries();

            // Build comparison maps
            const brokerMap = this.buildPositionMap(brokerPositions);
            const localMap = new Map<string, number>(
                localSummaries
                    .filter((s) => s.netQuantity !== 0)
                    .map((s) => [s.symbol, s.netQuantity])
            );

            // Find all unique symbols
            const allSymbols = new Set([...brokerMap.keys(), ...localMap.keys()]);

            // Compare positions
            const discrepancies: PositionDiscrepancy[] = [];
            const syncedSymbols: string[] = [];

            for (const symbol of allSymbols) {
                const brokerQty = brokerMap.get(symbol) ?? 0;
                const localQty = localMap.get(symbol) ?? 0;
                const difference = brokerQty - localQty;

                if (Math.abs(difference) > 0.001) {
                    // Significant difference
                    const discrepancy: PositionDiscrepancy = {
                        symbol,
                        localQuantity: localQty,
                        brokerQuantity: brokerQty,
                        difference,
                        action: this.determineAction(localQty, brokerQty, isStartup),
                    };
                    discrepancies.push(discrepancy);

                    logger.warn(
                        {
                            symbol,
                            localQty,
                            brokerQty,
                            difference,
                            action: discrepancy.action,
                        },
                        "Position discrepancy detected"
                    );

                    // Auto-sync from broker on startup for positions we don't have locally
                    if (isStartup && discrepancy.action === "SYNC_FROM_BROKER") {
                        await this.syncFromBroker(symbol, brokerPositions);
                        syncedSymbols.push(symbol);
                    }
                }
            }

            const result: ReconciliationResult = {
                timestamp: new Date(),
                hasDiscrepancies: discrepancies.length > 0,
                discrepancies,
                brokerPositionCount: brokerMap.size,
                localPositionCount: localMap.size,
                syncedSymbols,
            };

            this.lastReconciliation = result;

            if (discrepancies.length === 0) {
                logger.info(
                    { brokerPositions: brokerMap.size, localPositions: localMap.size },
                    "Position reconciliation complete - no discrepancies"
                );
            } else {
                logger.warn(
                    {
                        discrepancyCount: discrepancies.length,
                        syncedCount: syncedSymbols.length,
                    },
                    "Position reconciliation complete with discrepancies"
                );
            }

            return result;
        } finally {
            this.isReconciling = false;
        }
    }

    /**
     * Get the last reconciliation result
     */
    getLastResult(): ReconciliationResult | null {
        return this.lastReconciliation;
    }

    /**
     * Get current discrepancies
     */
    getDiscrepancies(): PositionDiscrepancy[] {
        return this.lastReconciliation?.discrepancies ?? [];
    }

    /**
     * Manually sync a position from broker
     */
    async syncSymbolFromBroker(symbol: string): Promise<void> {
        const brokerPositions = await this.broker.getPositions();
        await this.syncFromBroker(symbol, brokerPositions);
        // Re-run reconciliation to update state
        await this.reconcilePeriodic();
    }

    /**
     * Build a map of symbol -> net quantity from broker trades
     */
    private buildPositionMap(trades: Trade[]): Map<string, number> {
        const map = new Map<string, number>();
        for (const trade of trades) {
            const current = map.get(trade.symbol) ?? 0;
            const delta = trade.side === "BUY" ? trade.quantity : -trade.quantity;
            const newQty = current + delta;
            if (Math.abs(newQty) > 0.001) {
                map.set(trade.symbol, newQty);
            } else {
                map.delete(trade.symbol);
            }
        }
        return map;
    }

    /**
     * Determine what action to take for a discrepancy
     */
    private determineAction(
        localQty: number,
        brokerQty: number,
        _isStartup: boolean
    ): PositionDiscrepancy["action"] {
        // If we have no local position but broker has one - sync from broker
        if (localQty === 0 && brokerQty !== 0) {
            return "SYNC_FROM_BROKER";
        }

        // If broker has no position but we have one locally - needs review
        if (brokerQty === 0 && localQty !== 0) {
            return "MANUAL_REVIEW";
        }

        // Both have positions but different quantities - needs review
        return "MANUAL_REVIEW";
    }

    /**
     * Sync a symbol's position from broker by recording trades
     */
    private async syncFromBroker(symbol: string, brokerPositions: Trade[]): Promise<void> {
        const symbolTrades = brokerPositions.filter((t) => t.symbol === symbol);

        for (const trade of symbolTrades) {
            try {
                await this.portfolioService.recordExternalTrade(trade);
                logger.info({ symbol, side: trade.side, quantity: trade.quantity }, "Synced trade from broker");
            } catch (err) {
                logger.warn({ err, symbol }, "Failed to sync trade from broker");
            }
        }
    }

    /**
     * Create an empty result for error cases
     */
    private createEmptyResult(): ReconciliationResult {
        return {
            timestamp: new Date(),
            hasDiscrepancies: false,
            discrepancies: [],
            brokerPositionCount: 0,
            localPositionCount: 0,
            syncedSymbols: [],
        };
    }
}

export default ReconciliationService;
