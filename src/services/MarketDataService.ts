import { EventEmitter } from "events";
import type { MarketSnapshot, MarketTick } from "../types";
import { RingBuffer } from "../utils/RingBuffer";
import { IncrementalIndicatorSuite } from "./IncrementalIndicators";

export interface UpdateTickInput {
  symbol: string;
  price: number;
  volume: number;
  timestamp?: Date | string;
}

export interface SymbolData {
  currentTick: MarketTick;
  tickHistory: RingBuffer<MarketTick>;
  indicators: IncrementalIndicatorSuite;
}

// Default tick history size per symbol
const DEFAULT_HISTORY_SIZE = 1000;

export class MarketDataService extends EventEmitter {
  private readonly symbols = new Map<string, SymbolData>();
  private readonly historySize: number;

  constructor(historySize: number = DEFAULT_HISTORY_SIZE) {
    super();
    this.historySize = historySize;
  }

  /**
   * Update tick for a symbol. O(1) operation including indicator updates.
   */
  updateTick(input: UpdateTickInput): MarketTick {
    const timestamp = input.timestamp instanceof Date ? input.timestamp : new Date(input.timestamp ?? Date.now());
    const symbol = input.symbol.toUpperCase();

    const tick: MarketTick = {
      symbol,
      price: Number(input.price.toFixed(4)),
      volume: Number(input.volume.toFixed(2)),
      timestamp,
    };

    let symbolData = this.symbols.get(symbol);
    if (!symbolData) {
      symbolData = {
        currentTick: tick,
        tickHistory: new RingBuffer<MarketTick>(this.historySize),
        indicators: new IncrementalIndicatorSuite(),
      };
      this.symbols.set(symbol, symbolData);
    }

    // Update current tick and history
    symbolData.currentTick = tick;
    symbolData.tickHistory.push(tick);

    // Update incremental indicators (O(1) per indicator)
    symbolData.indicators.update(tick.price);

    this.emit("tick", tick);
    return tick;
  }

  /**
   * Get market snapshot for specified symbols (or all).
   */
  getSnapshot(symbols?: string[]): MarketSnapshot {
    const targetSymbols = symbols
      ? symbols.map(s => s.toUpperCase())
      : Array.from(this.symbols.keys());

    const tickList: MarketTick[] = [];
    for (const symbol of targetSymbols) {
      const data = this.symbols.get(symbol);
      if (data) {
        tickList.push(data.currentTick);
      }
    }

    return {
      ticks: tickList.sort((a, b) => a.symbol.localeCompare(b.symbol)),
      asOf: new Date(),
    };
  }

  /**
   * Get current tick for a symbol.
   */
  getTick(symbol: string): MarketTick | undefined {
    return this.symbols.get(symbol.toUpperCase())?.currentTick;
  }

  /**
   * Get tick history for a symbol.
   */
  getTickHistory(symbol: string, count?: number): MarketTick[] {
    const data = this.symbols.get(symbol.toUpperCase());
    if (!data) return [];
    return count ? data.tickHistory.last(count) : data.tickHistory.toArray();
  }

  /**
   * Get current indicator values for a symbol. O(1) operation (no recalculation).
   */
  getIndicators(symbol: string): ReturnType<IncrementalIndicatorSuite["getValues"]> | undefined {
    return this.symbols.get(symbol.toUpperCase())?.indicators.getValues();
  }

  /**
   * Check if indicators are ready for a symbol.
   */
  indicatorsReady(symbol: string): boolean {
    return this.symbols.get(symbol.toUpperCase())?.indicators.isReady ?? false;
  }

  /**
   * Get all tracked symbols.
   */
  getTrackedSymbols(): string[] {
    return Array.from(this.symbols.keys());
  }
}

export default MarketDataService;
