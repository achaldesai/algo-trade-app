import type BrokerClient from "../brokers/BrokerClient";
import type MarketDataService from "./MarketDataService";
import PortfolioService from "./PortfolioService";
import type {
  BrokerOrderExecution,
  MarketSnapshot,
  PortfolioSnapshot,
  StrategyExecutionResult,
  StrategySignal,
  Trade,
} from "../types";
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

    const signals = await strategy.generateSignals({
      market: marketSnapshot,
      portfolio: portfolioSnapshot,
      broker: this.broker,
    });

    const executions: StrategyExecutionResult[] = [];
    for (const signal of signals) {
      const executed = await this.executeSignal(signal);
      executions.push(executed);
    }

    return {
      strategyId,
      snapshot: {
        market: marketSnapshot,
        portfolio: portfolioSnapshot,
      },
      executions,
    };
  }

  async executeSignal(signal: StrategySignal): Promise<StrategyExecutionResult> {
    const executions: BrokerOrderExecution[] = [];
    for (const order of signal.requestedOrders) {
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
    }

    return { signal, executions };
  }
}

export default TradingEngine;
