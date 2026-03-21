import BaseStrategy, { type StrategyContext, type StrategyParamDefinition } from "./BaseStrategy";
import type { StrategySignal } from "../types";

// ─── Default values (used when no user override is set) ──────────────────────

const DEFAULT_THRESHOLD = 0.01;   // 1% deviation from VWAP
const DEFAULT_ORDER_SIZE = 10;

// ─── VWAP Mean Reversion Strategy ────────────────────────────────────────────

export class VWAPStrategy extends BaseStrategy {
  constructor() {
    super("vwap", "VWAP Mean Reversion", "Trades when price deviates materially from VWAP");
  }

  getParamSchema(): StrategyParamDefinition[] {
    return [
      {
        key: "threshold",
        label: "VWAP Deviation Threshold",
        type: "number",
        default: DEFAULT_THRESHOLD,
        description: "Minimum price-to-VWAP deviation (as decimal, e.g. 0.01 = 1%) to trigger a signal",
        min: 0.001,
        max: 0.1,
        step: 0.001,
      },
      {
        key: "orderSize",
        label: "Default Order Size",
        type: "number",
        default: DEFAULT_ORDER_SIZE,
        description: "Base number of shares per order (actual size may be larger if existing position is bigger)",
        min: 1,
        max: 1000,
        step: 1,
      },
    ];
  }

  getDefaultParams(): Record<string, unknown> {
    return {
      threshold: DEFAULT_THRESHOLD,
      orderSize: DEFAULT_ORDER_SIZE,
    };
  }

  async generateSignals(context: StrategyContext): Promise<StrategySignal[]> {
    const signals: StrategySignal[] = [];
    const threshold = (context.params.threshold as number) ?? DEFAULT_THRESHOLD;
    const baseOrderSize = (context.params.orderSize as number) ?? DEFAULT_ORDER_SIZE;

    for (const tick of context.market.ticks) {
      const position = context.portfolio.positions.find((item) => item.symbol === tick.symbol);
      const positionSize = position?.netQuantity ?? 0;

      // Use averagePrice (Day's VWAP) from tick if available, otherwise fallback to price
      const vwap = tick.averagePrice ?? tick.price;

      if (vwap === 0) continue;

      const deviation = (tick.price - vwap) / vwap;

      if (Math.abs(deviation) < threshold) {
        continue;
      }

      const direction = deviation > 0 ? "SELL" : "BUY";
      const orderSize = Math.max(baseOrderSize, Math.abs(positionSize));

      signals.push({
        strategyId: this.id,
        description: `${direction} ${orderSize} ${tick.symbol} @ ${tick.price.toFixed(2)} based on ${(
          deviation * 100
        ).toFixed(2)}% deviation from VWAP`,
        requestedOrders: [
          {
            symbol: tick.symbol,
            side: direction,
            quantity: orderSize,
            price: tick.price,
            type: "MARKET",
            tag: `VWAP-${Date.now()}`,
          },
        ],
      });
    }

    return signals;
  }
}

export default VWAPStrategy;
