import type { MarketSnapshot, MarketTick } from "../types";

export interface UpdateTickInput {
  symbol: string;
  price: number;
  volume: number;
  timestamp?: Date | string;
}

export class MarketDataService {
  private readonly ticks = new Map<string, MarketTick>();

  updateTick(input: UpdateTickInput): MarketTick {
    const timestamp = input.timestamp instanceof Date ? input.timestamp : new Date(input.timestamp ?? Date.now());

    const tick: MarketTick = {
      symbol: input.symbol.toUpperCase(),
      price: Number(input.price.toFixed(4)),
      volume: Number(input.volume.toFixed(2)),
      timestamp,
    };

    this.ticks.set(tick.symbol, tick);
    return tick;
  }

  getSnapshot(symbols?: string[]): MarketSnapshot {
    const tickList = symbols
      ? symbols
          .map((symbol) => this.ticks.get(symbol.toUpperCase()))
          .filter((tick): tick is MarketTick => Boolean(tick))
      : Array.from(this.ticks.values());

    return {
      ticks: tickList.sort((a, b) => a.symbol.localeCompare(b.symbol)),
      asOf: new Date(),
    };
  }

  getTick(symbol: string): MarketTick | undefined {
    return this.ticks.get(symbol.toUpperCase());
  }
}

export default MarketDataService;
