import type BrokerClient from "../brokers/BrokerClient";
import type { MarketSnapshot, PortfolioSnapshot, StrategySignal } from "../types";

// ─── Parameter Schema ────────────────────────────────────────────────────────

export interface StrategyParamDefinition {
  key: string;
  label: string;
  type: "number" | "boolean" | "string" | "select";
  default: unknown;
  description?: string;
  // Constraints (for "number" type)
  min?: number;
  max?: number;
  step?: number;
  // Options (for "select" type)
  options?: { value: string; label: string }[];
}

// ─── Strategy Context ────────────────────────────────────────────────────────

export interface StrategyContext {
  market: MarketSnapshot;
  portfolio: PortfolioSnapshot;
  broker: BrokerClient;
  /** Per-user parameters (strategy defaults merged with user overrides). */
  params: Record<string, unknown>;
}

// ─── Base Strategy ───────────────────────────────────────────────────────────

export abstract class BaseStrategy {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly description: string,
  ) { }

  /** Schema describing every tunable parameter for this strategy. */
  abstract getParamSchema(): StrategyParamDefinition[];

  /** Default values for all parameters. */
  abstract getDefaultParams(): Record<string, unknown>;

  /** Generate trading signals using market context and user params. */
  abstract generateSignals(context: StrategyContext): Promise<StrategySignal[]>;
}

export default BaseStrategy;
