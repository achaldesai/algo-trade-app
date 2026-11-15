import BaseStrategy, {
  type StrategyContext,
  type StrategyParamDefinition,
  type StrategyTimeframe,
} from "./BaseStrategy";
import { lastTwo, numberParam, rsi } from "./dailyIndicators";
import type { StrategySignal } from "../types";

const DEFAULT_PERIOD = 14;
const DEFAULT_OVERSOLD = 30;
const DEFAULT_EXIT = 55;
const DEFAULT_ORDER_SIZE = 10;

// ─── RSI Mean Reversion (daily) ──────────────────────────────────────────────

export class RsiMeanReversionStrategy extends BaseStrategy {
  override readonly timeframe: StrategyTimeframe = "1day";

  constructor() {
    super(
      "rsi-reversion",
      "RSI Mean Reversion",
      "Daily mean reversion: buys when RSI drops below the oversold level, exits when RSI recovers above the exit level",
    );
  }

  getParamSchema(): StrategyParamDefinition[] {
    return [
      { key: "period", label: "RSI Period (days)", type: "number", default: DEFAULT_PERIOD, min: 2, max: 50, step: 1 },
      { key: "oversold", label: "Oversold Level", type: "number", default: DEFAULT_OVERSOLD, min: 1, max: 50, step: 1 },
      {
        key: "exitLevel",
        label: "Exit Level",
        type: "number",
        default: DEFAULT_EXIT,
        description: "Sell the position once RSI rises above this level",
        min: 30,
        max: 99,
        step: 1,
      },
      { key: "orderSize", label: "Order Size", type: "number", default: DEFAULT_ORDER_SIZE, min: 1, max: 10000, step: 1 },
    ];
  }

  getDefaultParams(): Record<string, unknown> {
    return { period: DEFAULT_PERIOD, oversold: DEFAULT_OVERSOLD, exitLevel: DEFAULT_EXIT, orderSize: DEFAULT_ORDER_SIZE };
  }

  override getWarmupBars(params: Record<string, unknown>): number {
    // Wilder smoothing keeps converging well after the first `period` bars.
    return numberParam(params, "period", DEFAULT_PERIOD) * 5;
  }

  async generateSignals(context: StrategyContext): Promise<StrategySignal[]> {
    if (!context.bars) return [];

    const period = numberParam(context.params, "period", DEFAULT_PERIOD);
    const oversold = numberParam(context.params, "oversold", DEFAULT_OVERSOLD);
    const exitLevel = numberParam(context.params, "exitLevel", DEFAULT_EXIT);
    const orderSize = numberParam(context.params, "orderSize", DEFAULT_ORDER_SIZE);
    if (oversold >= exitLevel) {
      throw new Error(`oversold (${oversold}) must be less than exitLevel (${exitLevel})`);
    }

    const signals: StrategySignal[] = [];
    for (const [symbol, bars] of Object.entries(context.bars)) {
      if (bars.length === 0) continue;
      const [, value] = lastTwo(rsi(period), bars);
      if (value === undefined) continue;

      const held = context.portfolio.positions.find((p) => p.symbol === symbol)?.netQuantity ?? 0;
      const close = bars[bars.length - 1].close;

      let side: "BUY" | "SELL" | undefined;
      let quantity = 0;
      if (value < oversold && held <= 0) {
        side = "BUY";
        quantity = orderSize;
      } else if (value > exitLevel && held > 0) {
        side = "SELL";
        quantity = held;
      }
      if (!side) continue;

      signals.push({
        strategyId: this.id,
        description: `${side} ${quantity} ${symbol} @ ${close.toFixed(2)}: RSI(${period}) ${value.toFixed(1)} ${
          side === "BUY" ? `< ${oversold}` : `> ${exitLevel}`
        }`,
        requestedOrders: [
          {
            symbol,
            side,
            quantity,
            price: close,
            type: "MARKET",
            tag: `RSI-${context.market.asOf.getTime()}`,
          },
        ],
      });
    }
    return signals;
  }
}

export default RsiMeanReversionStrategy;
