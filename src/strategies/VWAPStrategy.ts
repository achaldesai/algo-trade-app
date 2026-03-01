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

      // Use averagePrice (Day's VWAP) from tick if available, otherwise fallback to price
      // Logic: If averagePrice is available, it is the most accurate VWAP.
      const vwap = tick.averagePrice ?? tick.price;

      if (vwap === 0) continue;

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
