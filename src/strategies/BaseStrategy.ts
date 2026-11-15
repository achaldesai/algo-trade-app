import type BrokerClient from "../brokers/BrokerClient";
import type { HistoricalCandle, MarketSnapshot, PortfolioSnapshot, StrategySignal } from "../types";

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
  userId: string;
  /**
   * Daily candles per symbol, oldest first, up to and including the bar being
   * evaluated. Supplied for `1day` strategies (backtests, daily runner); absent
   * on the live tick loop.
   */
  bars?: Record<string, HistoricalCandle[]>;
}

/**
 * `tick` strategies run on every market tick and read live data.
 * `1day` strategies run once per daily bar from `context.bars`, keep no state
 * between calls, and take time from `context.market.asOf` — so the same
 * instance can serve live trading and backtests.
 */
export type StrategyTimeframe = "tick" | "1day";

// ─── Base Strategy ───────────────────────────────────────────────────────────

export abstract class BaseStrategy {
  readonly timeframe: StrategyTimeframe = "tick";

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly description: string,
  ) { }

  /** Schema describing every tunable parameter for this strategy. */
  abstract getParamSchema(): StrategyParamDefinition[];

  /** Default values for all parameters. */
  abstract getDefaultParams(): Record<string, unknown>;

  /** Number of prior daily bars needed before the strategy can signal. */
  getWarmupBars(_params: Record<string, unknown>): number {
    return 0;
  }

  /** Generate trading signals using market context and user params. */
  abstract generateSignals(context: StrategyContext): Promise<StrategySignal[]>;
}

export default BaseStrategy;
