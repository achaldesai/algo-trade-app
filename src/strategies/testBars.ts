import type { StrategyContext } from "./BaseStrategy";
import type BrokerClient from "../brokers/BrokerClient";
import type { HistoricalCandle } from "../types";

// Shared fixtures for daily-strategy tests.

const DAY = 86_400_000;
const START = Date.UTC(2025, 0, 1);

export function barsFrom(symbol: string, closes: number[]): HistoricalCandle[] {
  return closes.map((close, i) => ({
    symbol,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    timestamp: new Date(START + i * DAY),
  }));
}

export function dailyContext(
  bars: Record<string, HistoricalCandle[]>,
  params: Record<string, unknown>,
  held: Record<string, number> = {},
): StrategyContext {
  const last = Object.values(bars)[0]?.at(-1)?.timestamp ?? new Date(START);
  return {
    market: { ticks: [], asOf: last },
    portfolio: {
      generatedAt: last,
      totalTrades: 0,
      positions: Object.entries(held).map(([symbol, netQuantity]) => ({
        symbol,
        name: symbol,
        netQuantity,
        averageEntryPrice: 0,
        realizedPnl: 0,
        position: netQuantity > 0 ? "LONG" : "FLAT",
        unrealizedPnl: 0,
      })),
    },
    broker: {} as BrokerClient,
    params,
    userId: "user-1",
    bars,
  };
}
