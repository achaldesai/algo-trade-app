import BaseStrategy, {
  type StrategyContext,
  type StrategyParamDefinition,
  type StrategyTimeframe,
} from "./BaseStrategy";
import {
  DEFAULT_SIZING_PARAMS,
  SIZING_PARAM_SCHEMA,
  buySizer,
  buySkipReason,
  lastTwo,
  movingAverage,
  numberParam,
} from "./dailyIndicators";
import type { StrategySignal } from "../types";

const DEFAULT_FAST = 20;
const DEFAULT_SLOW = 50;
const DEFAULT_MA_TYPE = "sma";

// ─── Moving Average Crossover (daily, trend following) ───────────────────────

export class MovingAverageCrossoverStrategy extends BaseStrategy {
  override readonly timeframe: StrategyTimeframe = "1day";

  constructor() {
    super(
      "ma-crossover",
      "Moving Average Crossover",
      "Daily trend following: buys when the fast moving average crosses above the slow one, exits on the cross back below",
    );
  }

  getParamSchema(): StrategyParamDefinition[] {
    return [
      { key: "fastPeriod", label: "Fast Period (days)", type: "number", default: DEFAULT_FAST, min: 2, max: 100, step: 1 },
      {
        key: "slowPeriod",
        label: "Slow Period (days)",
        type: "number",
        default: DEFAULT_SLOW,
        description: "Must be greater than the fast period",
        min: 3,
        max: 200,
        step: 1,
      },
      {
        key: "maType",
        label: "Average Type",
        type: "select",
        default: DEFAULT_MA_TYPE,
        options: [
          { value: "sma", label: "Simple (SMA)" },
          { value: "ema", label: "Exponential (EMA)" },
        ],
      },
      ...SIZING_PARAM_SCHEMA,
    ];
  }

  getDefaultParams(): Record<string, unknown> {
    return { fastPeriod: DEFAULT_FAST, slowPeriod: DEFAULT_SLOW, maType: DEFAULT_MA_TYPE, ...DEFAULT_SIZING_PARAMS };
  }

  override getWarmupBars(params: Record<string, unknown>): number {
    const slow = numberParam(params, "slowPeriod", DEFAULT_SLOW);
    // EMA keeps settling after its seed period, so give it extra history.
    return params.maType === "ema" ? slow * 3 : slow + 1;
  }

  async generateSignals(context: StrategyContext): Promise<StrategySignal[]> {
    if (!context.bars) return [];

    const fast = numberParam(context.params, "fastPeriod", DEFAULT_FAST);
    const slow = numberParam(context.params, "slowPeriod", DEFAULT_SLOW);
    const maType = context.params.maType === "ema" ? "ema" : "sma";
    const sizeBuy = buySizer(context.params, context.account);
    if (fast >= slow) {
      throw new Error(`fastPeriod (${fast}) must be less than slowPeriod (${slow})`);
    }

    const signals: StrategySignal[] = [];
    for (const [symbol, bars] of Object.entries(context.bars)) {
      if (bars.length === 0) continue;
      const [prevFast, curFast] = lastTwo(movingAverage(maType, fast), bars);
      const [prevSlow, curSlow] = lastTwo(movingAverage(maType, slow), bars);
      if (prevFast === undefined || curFast === undefined || prevSlow === undefined || curSlow === undefined) continue;

      const crossedUp = prevFast <= prevSlow && curFast > curSlow;
      const crossedDown = prevFast >= prevSlow && curFast < curSlow;
      const held = context.portfolio.positions.find((p) => p.symbol === symbol)?.netQuantity ?? 0;
      const close = bars[bars.length - 1].close;

      let side: "BUY" | "SELL" | undefined;
      let quantity = 0;
      if (crossedUp && held <= 0) {
        side = "BUY";
        quantity = sizeBuy(close);
      } else if (crossedDown && held > 0) {
        side = "SELL";
        quantity = held;
      }
      if (!side) continue;
      if (quantity <= 0) {
        const skippedReason = buySkipReason(context.params, context.account);
        signals.push({
          strategyId: this.id,
          description: `BUY ${symbol} @ ${close.toFixed(2)} skipped: ${skippedReason}`,
          requestedOrders: [],
          skippedReason,
        });
        continue;
      }

      signals.push({
        strategyId: this.id,
        description: `${side} ${quantity} ${symbol} @ ${close.toFixed(2)}: ${maType.toUpperCase()}${fast} crossed ${
          side === "BUY" ? "above" : "below"
        } ${maType.toUpperCase()}${slow}`,
        requestedOrders: [
          {
            symbol,
            side,
            quantity,
            price: close,
            type: "MARKET",
            tag: `MAX-${context.market.asOf.getTime()}`,
          },
        ],
      });
    }
    return signals;
  }
}

export default MovingAverageCrossoverStrategy;
