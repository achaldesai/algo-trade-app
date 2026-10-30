import BaseStrategy, { type StrategyContext, type StrategyParamDefinition } from "./BaseStrategy";
import type { StrategySignal } from "../types";

// ─── Default values (used when no user override is set) ──────────────────────

const DEFAULT_THRESHOLD = 0.01;   // 1% deviation from VWAP
const DEFAULT_ORDER_SIZE = 10;
const DEFAULT_COOLDOWN_MS = 300000;   // 5 minutes between signals per user/symbol

// ─── VWAP Mean Reversion Strategy ────────────────────────────────────────────

export class VWAPStrategy extends BaseStrategy {
  private readonly lastSignalAt = new Map<string, number>();

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
      {
        key: "cooldownMs",
        label: "Signal Cooldown (ms)",
        type: "number",
        default: DEFAULT_COOLDOWN_MS,
        description: "Minimum time between consecutive signals for the same user and symbol",
        min: 0,
        step: 1000,
      },
    ];
  }

  getDefaultParams(): Record<string, unknown> {
    return {
      threshold: DEFAULT_THRESHOLD,
      orderSize: DEFAULT_ORDER_SIZE,
      cooldownMs: DEFAULT_COOLDOWN_MS,
    };
  }

  async generateSignals(context: StrategyContext): Promise<StrategySignal[]> {
    const signals: StrategySignal[] = [];
    const threshold = (context.params.threshold as number) ?? DEFAULT_THRESHOLD;
    const baseOrderSize = (context.params.orderSize as number) ?? DEFAULT_ORDER_SIZE;
    const cooldownMs = (context.params.cooldownMs as number) ?? DEFAULT_COOLDOWN_MS;

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

      // Position gate: long-only, no pyramiding / no overselling
      if (direction === "BUY" && positionSize > 0) continue;
      if (direction === "SELL" && positionSize <= 0) continue;

      // Cooldown gate: one signal per user/symbol within the cooldown window
      const key = `${context.userId}:${tick.symbol}`;
      if (Date.now() - (this.lastSignalAt.get(key) ?? -Infinity) < cooldownMs) {
        continue;
      }

      const orderSize = direction === "BUY" ? baseOrderSize : Math.abs(positionSize);

      this.lastSignalAt.set(key, Date.now());

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
