import type { MarketTick } from "../types";
import type MarketDataService from "./MarketDataService";
import type TradingEngine from "./TradingEngine";
import type { UserRepository } from "../persistence/UserRepository";
import logger from "../utils/logger";

export type EvaluationMode = "parallel" | "sequential";

export interface TradingLoopOptions {
    /**
     * How to evaluate strategies on each tick.
     * - parallel: All strategies evaluate concurrently (default, faster)
     * - sequential: Strategies evaluate one by one (for order-dependent strategies)
     */
    evaluationMode?: EvaluationMode;

    /**
     * Filter strategies to specific symbols (optional optimization).
     * If set, only strategies that care about the incoming tick symbol will evaluate.
     */
    filterBySymbol?: boolean;
}

export class TradingLoopService {
    private isRunning = false;
    private static instance: TradingLoopService;
    private evaluationMode: EvaluationMode = "parallel";
    private filterBySymbol = false;
    private evaluationInProgress = false;

    constructor(
        private readonly marketDataService: MarketDataService,
        private readonly tradingEngine: TradingEngine,
        private readonly userRepository: UserRepository,
        options?: TradingLoopOptions
    ) {
        if (options?.evaluationMode) {
            this.evaluationMode = options.evaluationMode;
        }
        if (options?.filterBySymbol !== undefined) {
            this.filterBySymbol = options.filterBySymbol;
        }
    }

    static getInstance(
        marketDataService?: MarketDataService,
        tradingEngine?: TradingEngine,
        userRepository?: UserRepository,
        options?: TradingLoopOptions
    ): TradingLoopService {
        if (!TradingLoopService.instance) {
            if (!marketDataService || !tradingEngine || !userRepository) {
                throw new Error("TradingLoopService not initialized");
            }
            TradingLoopService.instance = new TradingLoopService(
                marketDataService,
                tradingEngine,
                userRepository,
                options
            );
        }
        return TradingLoopService.instance;
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
        if (!this.isRunning) {
            return;
        }

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
            const users = await this.userRepository.listUsers();
            const strategies = this.tradingEngine.getStrategies();

            if (this.evaluationMode === "parallel") {
                // Parallel evaluation - evaluate all strategies concurrently for all users
                const evaluations: Promise<unknown>[] = [];
                for (const user of users) {
                    for (const strategy of strategies) {
                        evaluations.push(this.tradingEngine.evaluate(strategy.id, user.id));
                    }
                }
                await Promise.all(evaluations);
            } else {
                // Sequential evaluation - maintain order dependency
                for (const user of users) {
                    for (const strategy of strategies) {
                        await this.tradingEngine.evaluate(strategy.id, user.id);
                    }
                }
            }

            const elapsed = performance.now() - startTime;
            if (elapsed > 50) {
                // Log slow evaluations (> 50ms)
                logger.warn(
                    { symbol: tick.symbol, elapsedMs: elapsed.toFixed(2), strategyCount: strategies.length },
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
