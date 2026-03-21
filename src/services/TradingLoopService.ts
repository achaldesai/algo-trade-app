import type { MarketTick } from "../types";
import type MarketDataService from "./MarketDataService";
import type TradingEngine from "./TradingEngine";
import type { UserRepo } from "../db/repositories/UserRepo";
import type { StrategyConfigRepo } from "../db/repositories/StrategyConfigRepo";
import logger from "../utils/logger";

export type EvaluationMode = "parallel" | "sequential";

export interface TradingLoopOptions {
    evaluationMode?: EvaluationMode;
    filterBySymbol?: boolean;
}

/**
 * TradingLoopService evaluates strategies on every market tick.
 *
 * Per-user strategy filtering:
 * - If a user has strategy configs, only enabled strategies are evaluated
 *   with the user's custom params.
 * - If a user has NO configs at all, ALL registered strategies are evaluated
 *   with default params (opt-in on first config save).
 */
export class TradingLoopService {
    private isRunning = false;
    private evaluationMode: EvaluationMode = "parallel";
    private filterBySymbol = false;
    private evaluationInProgress = false;

    constructor(
        private readonly marketDataService: MarketDataService,
        private readonly tradingEngine: TradingEngine,
        private readonly userRepository: UserRepo,
        private readonly strategyConfigRepo: StrategyConfigRepo,
        options?: TradingLoopOptions
    ) {
        if (options?.evaluationMode) {
            this.evaluationMode = options.evaluationMode;
        }
        if (options?.filterBySymbol !== undefined) {
            this.filterBySymbol = options.filterBySymbol;
        }
    }

    start(): void {
        if (this.isRunning) {
            logger.info("Trading loop already running");
            return;
        }

        this.isRunning = true;
        this.marketDataService.on("tick", this.handleTick);
        logger.info({ evaluationMode: this.evaluationMode }, "Trading loop started");
    }

    stop(): void {
        if (!this.isRunning) return;

        this.isRunning = false;
        this.marketDataService.off("tick", this.handleTick);
        logger.info("Trading loop stopped");
    }

    getStatus(): { running: boolean; mode: EvaluationMode; evaluating: boolean } {
        return {
            running: this.isRunning,
            mode: this.evaluationMode,
            evaluating: this.evaluationInProgress,
        };
    }

    setEvaluationMode(mode: EvaluationMode): void {
        this.evaluationMode = mode;
        logger.info({ evaluationMode: mode }, "Evaluation mode changed");
    }

    private handleTick = async (tick: MarketTick) => {
        if (!this.isRunning) return;

        // Skip if previous evaluation still in progress (prevent queue buildup)
        if (this.evaluationInProgress) {
            logger.debug({ symbol: tick.symbol }, "Skipping tick - evaluation in progress");
            return;
        }

        this.evaluationInProgress = true;
        const startTime = performance.now();

        try {
            const users = this.userRepository.listUsers();
            const allStrategies = this.tradingEngine.getStrategies();

            if (this.evaluationMode === "parallel") {
                const evaluations: Promise<unknown>[] = [];
                for (const user of users) {
                    const activeConfigs = this.strategyConfigRepo.getActiveStrategies(user.id);

                    if (activeConfigs.length > 0) {
                        // User has configs — evaluate only enabled strategies with custom params
                        for (const config of activeConfigs) {
                            evaluations.push(
                                this.tradingEngine.evaluate(config.strategyId, user.id, config.params)
                            );
                        }
                    } else {
                        // No configs yet — evaluate all strategies with defaults
                        for (const strategy of allStrategies) {
                            evaluations.push(
                                this.tradingEngine.evaluate(strategy.id, user.id)
                            );
                        }
                    }
                }
                await Promise.all(evaluations);
            } else {
                for (const user of users) {
                    const activeConfigs = this.strategyConfigRepo.getActiveStrategies(user.id);

                    if (activeConfigs.length > 0) {
                        for (const config of activeConfigs) {
                            await this.tradingEngine.evaluate(config.strategyId, user.id, config.params);
                        }
                    } else {
                        for (const strategy of allStrategies) {
                            await this.tradingEngine.evaluate(strategy.id, user.id);
                        }
                    }
                }
            }

            const elapsed = performance.now() - startTime;
            if (elapsed > 50) {
                logger.warn(
                    { symbol: tick.symbol, elapsedMs: elapsed.toFixed(2), strategyCount: allStrategies.length },
                    "Slow strategy evaluation"
                );
            }
        } catch (error) {
            logger.error({ err: error, symbol: tick.symbol }, "Error in trading loop");
        } finally {
            this.evaluationInProgress = false;
        }
    };
}

export default TradingLoopService;
