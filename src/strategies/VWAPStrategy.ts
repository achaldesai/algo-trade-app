import BaseStrategy, { type StrategyContext } from "./BaseStrategy";
import type { StrategySignal } from "../types";

const VWAP_THRESHOLD = 0.01; // 1%
const DEFAULT_ORDER_SIZE = 10;

export class VWAPStrategy extends BaseStrategy {
  constructor() {
    super("vwap", "VWAP Mean Reversion", "Trades when price deviates materially from VWAP");
  }

  async generateSignals(context: StrategyContext): Promise<StrategySignal[]> {
    const signals: StrategySignal[] = [];

    for (const tick of context.market.ticks) {
      const position = context.portfolio.positions.find((item) => item.symbol === tick.symbol);
      const positionSize = position?.netQuantity ?? 0;
      const referenceVolume = Math.max(Math.abs(positionSize), 1);
      const vwapDenominator = tick.volume + referenceVolume;
      const vwapNumerator = tick.price * tick.volume + (position?.averageEntryPrice ?? tick.price) * referenceVolume;
      const vwap = vwapDenominator > 0 ? vwapNumerator / vwapDenominator : tick.price;

      const deviation = (tick.price - vwap) / vwap;

      if (Math.abs(deviation) < VWAP_THRESHOLD) {
        continue;
      }

      const direction = deviation > 0 ? "SELL" : "BUY";
      const orderSize = Math.max(DEFAULT_ORDER_SIZE, Math.abs(positionSize));

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
            price: tick.price, // Include current market price
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
