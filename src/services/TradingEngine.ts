import type BrokerClient from "../brokers/BrokerClient";
import PaperBroker from "../brokers/PaperBroker";
import type MarketDataService from "./MarketDataService";
import PortfolioService from "./PortfolioService";
import type {
  BrokerOrderExecution,
  BrokerOrderFailure,
  BrokerOrderRequest,
  MarketSnapshot,
  PortfolioSnapshot,
  StrategyEvaluationError,
  StrategyExecutionResult,
  StrategySignal,
  Trade,
} from "../types";
import logger from "../utils/logger";
import type BaseStrategy from "../strategies/BaseStrategy";
import { HttpError } from "../utils/HttpError";
import env from "../config/env";

export interface TradingEngineOptions {
  broker: BrokerClient;
  fallbackBroker?: BrokerClient;
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

  private readonly primaryBroker: BrokerClient;

  private readonly fallbackBroker: BrokerClient;

  private activeBroker: BrokerClient;

  private readonly portfolioService: PortfolioService;

  private readonly marketData: MarketDataService;

  constructor(options: TradingEngineOptions) {
    this.primaryBroker = options.broker;
    this.fallbackBroker = options.fallbackBroker ?? new PaperBroker();
    this.activeBroker = this.primaryBroker;
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

  private async ensureBrokerConnected(broker: BrokerClient): Promise<void> {
    if (!broker.isConnected()) {
      await broker.connect();
    }
  }

  async connect(): Promise<void> {
    await this.ensureBrokerConnected(this.activeBroker);
  }

  async evaluate(strategyId: string): Promise<StrategyEvaluationResult> {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new HttpError(404, `Unknown strategy ${strategyId}`);
    }

    const errors: StrategyEvaluationError[] = [];

    this.activeBroker = this.primaryBroker;
    try {
      await this.connect();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to connect broker";
      errors.push({ stage: "BROKER_CONNECTION", message, details: this.serializeError(error) });
      logger.error(
        { err: error, strategyId, broker: this.primaryBroker.name },
        "Primary broker connection failed, using paper fallback",
      );

      this.activeBroker = this.fallbackBroker;
      try {
        await this.connect();
      } catch (fallbackError) {
        const fallbackMessage =
          fallbackError instanceof Error ? fallbackError.message : "Failed to connect fallback broker";
        errors.push({
          stage: "BROKER_CONNECTION",
          message: fallbackMessage,
          details: this.serializeError(fallbackError),
        });
        logger.error(
          { err: fallbackError, strategyId, broker: this.fallbackBroker.name },
          "Fallback broker connection failed",
        );

        const marketSnapshot = this.marketData.getSnapshot();
        const portfolioSnapshot = await this.portfolioService.getSnapshot();
        return {
          strategyId,
          snapshot: {
            market: marketSnapshot,
            portfolio: portfolioSnapshot,
          },
          executions: [],
          errors,
        } satisfies StrategyEvaluationResult;
      }
    }

    const marketSnapshot = this.marketData.getSnapshot();
    const portfolioSnapshot = await this.portfolioService.getSnapshot();

    const broker = this.activeBroker;

    let signals: StrategySignal[] = [];
    try {
      signals = await strategy.generateSignals({
        market: marketSnapshot,
        portfolio: portfolioSnapshot,
        broker,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to generate strategy signals";
      errors.push({ stage: "SIGNAL_GENERATION", message, details: this.serializeError(error) });
      logger.error({ err: error, strategyId }, "Strategy signal generation failed");
    }

    const executions: StrategyExecutionResult[] = [];
    for (const signal of signals) {
      try {
        const executed = await this.executeSignal(broker, signal);
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

  async executeSignal(broker: BrokerClient, signal: StrategySignal): Promise<StrategyExecutionResult> {
    const executions: BrokerOrderExecution[] = [];
    const failures: BrokerOrderFailure[] = [];

    // Check dry-run mode
    if (env.dryRun) {
      logger.info(
        {
          dryRun: true,
          strategyId: signal.strategyId,
          orders: signal.requestedOrders
        },
        "🔍 DRY RUN: Would execute orders (not executing in dry-run mode)"
      );

      // Return mock executions for dry-run mode
      for (const order of signal.requestedOrders) {
        executions.push({
          id: `dry-run-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          request: order,
          status: "COMPLETED" as any, // Mock as completed for dry-run
          filledQuantity: 0, // No actual fill in dry-run
          averagePrice: order.price ?? 0,
          executedAt: new Date(),
        });
      }

      return { signal, executions, failures };
    }

    // Normal execution
    for (const order of signal.requestedOrders) {
      try {
        // Validate order before execution
        this.validateOrder(order);

        const execution = await broker.placeOrder(order);
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
          await this.portfolioService.recordExternalTrade(trade);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Order execution failed";
        failures.push({ request: order, error: message, details: this.serializeError(error) });
        logger.error({ err: error, symbol: order.symbol, side: order.side }, "Broker order execution failed");
      }
    }

    return { signal, executions, failures };
  }

  /**
   * Validates an order before execution
   * Checks position size limits and capital availability
   */
  private validateOrder(order: BrokerOrderRequest): void {
    // Validate price exists and is positive
    if (!order.price || order.price <= 0) {
      throw new Error(`Invalid price: ${order.price} (must be > 0)`);
    }

    const positionValue = order.quantity * order.price;

    // Check max position size
    if (positionValue > env.maxPositionSize) {
      throw new Error(
        `Order exceeds max position size: ${positionValue.toFixed(2)} > ${env.maxPositionSize}`
      );
    }

    // Validate quantity is positive
    if (order.quantity <= 0) {
      throw new Error(`Invalid quantity: ${order.quantity} (must be > 0)`);
    }
  }

  private serializeError(error: unknown): unknown {
    if (error instanceof Error) {
      return { message: error.message, stack: error.stack };
    }
    return error;
  }
}

export default TradingEngine;
