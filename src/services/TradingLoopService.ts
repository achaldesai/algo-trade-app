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

interface PlannedEvaluation {
    strategyId: string;
    userId: string;
    params?: Record<string, unknown>;
}

/**
 * TradingLoopService evaluates strategies on every market tick.
 *
 * Per-user strategy filtering:
 * - If a user has strategy configs, only enabled strategies are evaluated
 *   with the user's custom params.
 * - If a user has NO configs at all, ALL tick strategies are evaluated
 *   with default params (opt-in on first config save).
 * - Daily (`1day`) strategies are never evaluated here; DailyStrategyRunner
 *   runs them once per trading day.
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

    /**
     * Which tick strategies to evaluate for a user. A user with any saved config
     * (enabled or not) gets exactly their enabled tick strategies; only a user
     * with no configs at all falls back to every tick strategy with defaults.
     */
    private planEvaluations(userId: string, tickStrategies: { id: string }[]): PlannedEvaluation[] {
        const configs = this.strategyConfigRepo.getAllConfigs(userId);
        if (configs.length === 0) {
            return tickStrategies.map((s) => ({ strategyId: s.id, userId }));
        }
        const tickIds = new Set(tickStrategies.map((s) => s.id));
        return configs
            .filter((c) => c.enabled && tickIds.has(c.strategyId))
            .map((c) => ({ strategyId: c.strategyId, userId, params: c.params }));
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
            // Daily (`1day`) strategies run once a day via DailyStrategyRunner, not per tick.
            const allStrategies = this.tradingEngine.getStrategies().filter((s) => s.timeframe === "tick");
            const evaluations = users.flatMap((user) => this.planEvaluations(user.id, allStrategies));

            if (this.evaluationMode === "parallel") {
                await Promise.all(
                    evaluations.map((e) => this.tradingEngine.evaluate(e.strategyId, e.userId, e.params)),
                );
            } else {
                for (const e of evaluations) {
                    await this.tradingEngine.evaluate(e.strategyId, e.userId, e.params);
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
