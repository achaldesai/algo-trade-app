import type BrokerClient from "../brokers/BrokerClient";
import type { MarketSnapshot, PortfolioSnapshot, StrategySignal } from "../types";

export interface StrategyContext {
  market: MarketSnapshot;
  portfolio: PortfolioSnapshot;
  broker: BrokerClient;
}

export abstract class BaseStrategy {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly description: string,
  ) {}

  abstract generateSignals(context: StrategyContext): Promise<StrategySignal[]>;
}

export default BaseStrategy;
