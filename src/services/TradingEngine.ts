import type BrokerClient from "../brokers/BrokerClient";
import type MarketDataService from "./MarketDataService";
import PortfolioService from "./PortfolioService";
import type {
  BrokerOrderExecution,
  BrokerOrderFailure,
  MarketSnapshot,
  PortfolioSnapshot,
  StrategyEvaluationError,
  StrategyExecutionResult,
  StrategySignal,
  Trade,
} from "../types";
import logger from "../utils/logger";
import type BaseStrategy from "../strategies/BaseStrategy";

export interface TradingEngineOptions {
  broker: BrokerClient;
  portfolioService: PortfolioService;
  marketData: MarketDataService;
}

export interface StrategyEvaluationResult {
  strategyId: string;
  snapshot: {
    market: MarketSnapshot;
    portfolio: PortfolioSnapshot;
  };
  executions: StrategyExecutionResult[];
  errors: StrategyEvaluationError[];
}

export class TradingEngine {
  private readonly strategies = new Map<string, BaseStrategy>();

  private readonly broker: BrokerClient;

  private readonly portfolioService: PortfolioService;

  private readonly marketData: MarketDataService;

  constructor(options: TradingEngineOptions) {
    this.broker = options.broker;
    this.portfolioService = options.portfolioService;
    this.marketData = options.marketData;
  }

  registerStrategy(strategy: BaseStrategy): void {
    this.strategies.set(strategy.id, strategy);
  }

  getStrategies(): BaseStrategy[] {
    return Array.from(this.strategies.values());
  }

  getStrategy(id: string): BaseStrategy | undefined {
    return this.strategies.get(id);
  }

  async connect(): Promise<void> {
    if (!this.broker.isConnected()) {
      await this.broker.connect();
    }
  }

  async evaluate(strategyId: string): Promise<StrategyEvaluationResult> {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`Unknown strategy ${strategyId}`);
    }

    await this.connect();

    const marketSnapshot = this.marketData.getSnapshot();
    const portfolioSnapshot = this.portfolioService.getSnapshot();

    const errors: StrategyEvaluationError[] = [];

    let signals: StrategySignal[] = [];
    try {
      signals = await strategy.generateSignals({
        market: marketSnapshot,
        portfolio: portfolioSnapshot,
        broker: this.broker,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to generate strategy signals";
      errors.push({ stage: "SIGNAL_GENERATION", message, details: this.serializeError(error) });
      logger.error({ err: error, strategyId }, "Strategy signal generation failed");
    }

    const executions: StrategyExecutionResult[] = [];
    for (const signal of signals) {
      try {
        const executed = await this.executeSignal(signal);
        executions.push(executed);
        if (executed.failures.length > 0) {
          errors.push(
            ...executed.failures.map((failure) => ({
              stage: "EXECUTION" as const,
              message: failure.error,
              details: { request: failure.request },
            } satisfies StrategyEvaluationError)),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to execute strategy signal";
        errors.push({ stage: "EXECUTION", message, details: { signal, error: this.serializeError(error) } });
        logger.error({ err: error, strategyId, signalId: signal.strategyId }, "Strategy execution failed");
      }
    }

    return {
      strategyId,
      snapshot: {
        market: marketSnapshot,
        portfolio: portfolioSnapshot,
      },
      executions,
      errors,
    };
  }

  async executeSignal(signal: StrategySignal): Promise<StrategyExecutionResult> {
    const executions: BrokerOrderExecution[] = [];
    const failures: BrokerOrderFailure[] = [];
    for (const order of signal.requestedOrders) {
      try {
        const execution = await this.broker.placeOrder(order);
        executions.push(execution);

        if (execution.filledQuantity > 0 && execution.status !== "REJECTED") {
          const trade: Trade = {
            id: execution.id,
            symbol: execution.request.symbol,
            side: execution.request.side,
            quantity: execution.filledQuantity,
            price: execution.averagePrice,
            executedAt: execution.executedAt,
          };
          this.portfolioService.recordExternalTrade(trade);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Order execution failed";
        failures.push({ request: order, error: message, details: this.serializeError(error) });
        logger.error({ err: error, symbol: order.symbol, side: order.side }, "Broker order execution failed");
      }
    }

    return { signal, executions, failures };
  }

  private serializeError(error: unknown): unknown {
    if (error instanceof Error) {
      return { message: error.message, stack: error.stack };
    }
    return error;
  }
}

export default TradingEngine;
