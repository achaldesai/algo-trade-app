/**
 * Incremental technical indicators that update in O(1) time per tick.
 * Instead of recalculating entire history, these maintain running state.
 */

import { RingBuffer } from "../utils/RingBuffer";

/**
 * Incremental EMA - O(1) update per tick
 */
export class IncrementalEMA {
    private currentValue: number | undefined;
    private readonly multiplier: number;
    private initialized = false;
    private readonly initBuffer: number[] = [];

    constructor(private readonly period: number) {
        if (period <= 0) throw new Error("EMA period must be positive");
        this.multiplier = 2 / (period + 1);
    }

    /**
     * Update with new price. Returns current EMA value.
     */
    update(price: number): number | undefined {
        if (!this.initialized) {
            this.initBuffer.push(price);
            if (this.initBuffer.length >= this.period) {
                // Initialize with SMA (industry standard)
                this.currentValue = this.initBuffer.reduce((a, b) => a + b, 0) / this.period;
                this.initialized = true;
            }
            return this.currentValue;
        }

        // O(1) EMA update formula
        this.currentValue = (price - this.currentValue!) * this.multiplier + this.currentValue!;
        return this.currentValue;
    }

    get value(): number | undefined {
        return this.currentValue;
    }

    get isReady(): boolean {
        return this.initialized;
    }

    reset(): void {
        this.currentValue = undefined;
        this.initialized = false;
        this.initBuffer.length = 0;
    }
}

/**
 * Incremental SMA using ring buffer - O(1) update per tick
 */
export class IncrementalSMA {
    private readonly buffer: RingBuffer<number>;
    private sum = 0;

    constructor(private readonly period: number) {
        if (period <= 0) throw new Error("SMA period must be positive");
        this.buffer = new RingBuffer(period);
    }

    /**
     * Update with new price. Returns current SMA value.
     */
    update(price: number): number | undefined {
        // If buffer is full, subtract oldest value
        if (this.buffer.isFull()) {
            const oldest = this.buffer.get(0);
            if (oldest !== undefined) {
                this.sum -= oldest;
            }
        }

        this.buffer.push(price);
        this.sum += price;

        if (this.buffer.size < this.period) {
            return undefined;
        }

        return this.sum / this.period;
    }

    get value(): number | undefined {
        if (this.buffer.size < this.period) return undefined;
        return this.sum / this.period;
    }

    get isReady(): boolean {
        return this.buffer.size >= this.period;
    }

    reset(): void {
        this.buffer.clear();
        this.sum = 0;
    }
}

/**
 * Incremental RSI - O(1) update per tick using Wilder's smoothing
 */
export class IncrementalRSI {
    private avgGain = 0;
    private avgLoss = 0;
    private previousPrice: number | undefined;
    private count = 0;

    constructor(private readonly period: number = 14) {
        if (period <= 0) throw new Error("RSI period must be positive");
    }

    /**
     * Update with new price. Returns current RSI value.
     */
    update(price: number): number | undefined {
        if (this.previousPrice === undefined) {
            this.previousPrice = price;
            return undefined;
        }

        const change = price - this.previousPrice;
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        this.previousPrice = price;
        this.count++;

        if (this.count <= this.period) {
            // Initial period: accumulate sum for first average
            this.avgGain += gain;
            this.avgLoss += loss;

            if (this.count === this.period) {
                this.avgGain /= this.period;
                this.avgLoss /= this.period;
            } else {
                return undefined;
            }
        } else {
            // Wilder's smoothing (exponential moving average of gains/losses)
            this.avgGain = (this.avgGain * (this.period - 1) + gain) / this.period;
            this.avgLoss = (this.avgLoss * (this.period - 1) + loss) / this.period;
        }

        if (this.avgLoss === 0) {
            return 100; // No losses = extreme bullish
        }

        const rs = this.avgGain / this.avgLoss;
        return 100 - 100 / (1 + rs);
    }

    get value(): number | undefined {
        if (this.count < this.period) return undefined;
        if (this.avgLoss === 0) return 100;
        const rs = this.avgGain / this.avgLoss;
        return 100 - 100 / (1 + rs);
    }

    get isReady(): boolean {
        return this.count >= this.period;
    }

    reset(): void {
        this.avgGain = 0;
        this.avgLoss = 0;
        this.previousPrice = undefined;
        this.count = 0;
    }
}

/**
 * Incremental MACD - O(1) update per tick
 * Combines two EMAs and a signal line
 */
export class IncrementalMACD {
    private readonly fastEMA: IncrementalEMA;
    private readonly slowEMA: IncrementalEMA;
    private readonly signalEMA: IncrementalEMA;

    constructor(
        fastPeriod: number = 12,
        slowPeriod: number = 26,
        signalPeriod: number = 9
    ) {
        this.fastEMA = new IncrementalEMA(fastPeriod);
        this.slowEMA = new IncrementalEMA(slowPeriod);
        this.signalEMA = new IncrementalEMA(signalPeriod);
    }

    /**
     * Update with new price. Returns MACD, signal, and histogram.
     */
    update(price: number): { macd: number; signal: number; histogram: number } | undefined {
        const fast = this.fastEMA.update(price);
        const slow = this.slowEMA.update(price);

        if (fast === undefined || slow === undefined) {
            return undefined;
        }

        const macd = fast - slow;
        const signal = this.signalEMA.update(macd);

        if (signal === undefined) {
            return undefined;
        }

        return {
            macd,
            signal,
            histogram: macd - signal,
        };
    }

    get value(): { macd: number; signal: number; histogram: number } | undefined {
        const fast = this.fastEMA.value;
        const slow = this.slowEMA.value;
        const signal = this.signalEMA.value;

        if (fast === undefined || slow === undefined || signal === undefined) {
            return undefined;
        }

        const macd = fast - slow;
        return {
            macd,
            signal,
            histogram: macd - signal,
        };
    }

    get isReady(): boolean {
        return this.signalEMA.isReady;
    }

    reset(): void {
        this.fastEMA.reset();
        this.slowEMA.reset();
        this.signalEMA.reset();
    }
}

/**
 * Incremental Bollinger Bands - O(1) update per tick using Welford's algorithm
 */
export class IncrementalBollingerBands {
    private readonly sma: IncrementalSMA;
    private readonly buffer: RingBuffer<number>;
    private sumSquares = 0;
    private sum = 0;

    constructor(
        private readonly period: number = 20,
        private readonly stdDevMultiplier: number = 2
    ) {
        if (period <= 0) throw new Error("Bollinger period must be positive");
        this.sma = new IncrementalSMA(period);
        this.buffer = new RingBuffer(period);
    }

    /**
     * Update with new price. Returns upper, middle, lower bands.
     */
    update(price: number): { upper: number; middle: number; lower: number } | undefined {
        // Remove oldest contribution if buffer is full
        if (this.buffer.isFull()) {
            const oldest = this.buffer.get(0);
            if (oldest !== undefined) {
                this.sum -= oldest;
                this.sumSquares -= oldest * oldest;
            }
        }

        this.buffer.push(price);
        this.sum += price;
        this.sumSquares += price * price;

        const middle = this.sma.update(price);
        if (middle === undefined) {
            return undefined;
        }

        // Calculate standard deviation using sum of squares
        // variance = E[X²] - E[X]²
        const meanSquare = this.sumSquares / this.period;
        const squareMean = middle * middle;
        const variance = meanSquare - squareMean;
        const stdDev = Math.sqrt(Math.max(0, variance)); // Protect against floating point errors

        return {
            upper: middle + this.stdDevMultiplier * stdDev,
            middle,
            lower: middle - this.stdDevMultiplier * stdDev,
        };
    }

    get value(): { upper: number; middle: number; lower: number } | undefined {
        const middle = this.sma.value;
        if (middle === undefined) return undefined;

        const meanSquare = this.sumSquares / this.period;
        const squareMean = middle * middle;
        const variance = meanSquare - squareMean;
        const stdDev = Math.sqrt(Math.max(0, variance));

        return {
            upper: middle + this.stdDevMultiplier * stdDev,
            middle,
            lower: middle - this.stdDevMultiplier * stdDev,
        };
    }

    get isReady(): boolean {
        return this.sma.isReady;
    }

    reset(): void {
        this.sma.reset();
        this.buffer.clear();
        this.sumSquares = 0;
        this.sum = 0;
    }
}

/**
 * Combined incremental indicator suite for a single symbol.
 * Maintains all indicators with O(1) updates per tick.
 */
export class IncrementalIndicatorSuite {
    private readonly sma: IncrementalSMA;
    private readonly ema: IncrementalEMA;
    private readonly rsi: IncrementalRSI;
    private readonly macd: IncrementalMACD;
    private readonly bollinger: IncrementalBollingerBands;

    constructor(options?: {
        smaPeriod?: number;
        emaPeriod?: number;
        rsiPeriod?: number;
        macdFast?: number;
        macdSlow?: number;
        macdSignal?: number;
        bollingerPeriod?: number;
        bollingerStdDev?: number;
    }) {
        const opts = options || {};
        this.sma = new IncrementalSMA(opts.smaPeriod || 20);
        this.ema = new IncrementalEMA(opts.emaPeriod || 20);
        this.rsi = new IncrementalRSI(opts.rsiPeriod || 14);
        this.macd = new IncrementalMACD(
            opts.macdFast || 12,
            opts.macdSlow || 26,
            opts.macdSignal || 9
        );
        this.bollinger = new IncrementalBollingerBands(
            opts.bollingerPeriod || 20,
            opts.bollingerStdDev || 2
        );
    }

    /**
     * Update all indicators with new price. O(1) operation.
     */
    update(price: number): {
        sma?: number;
        ema?: number;
        rsi?: number;
        macd?: { macd: number; signal: number; histogram: number };
        bollinger?: { upper: number; middle: number; lower: number };
    } {
        return {
            sma: this.sma.update(price),
            ema: this.ema.update(price),
            rsi: this.rsi.update(price),
            macd: this.macd.update(price),
            bollinger: this.bollinger.update(price),
        };
    }

    /**
     * Get all current indicator values without update.
     */
    getValues(): {
        sma?: number;
        ema?: number;
        rsi?: number;
        macd?: { macd: number; signal: number; histogram: number };
        bollinger?: { upper: number; middle: number; lower: number };
    } {
        return {
            sma: this.sma.value,
            ema: this.ema.value,
            rsi: this.rsi.value,
            macd: this.macd.value,
            bollinger: this.bollinger.value,
        };
    }

    /**
     * Check if all indicators are ready.
     */
    get isReady(): boolean {
        return (
            this.sma.isReady &&
            this.ema.isReady &&
            this.rsi.isReady &&
            this.macd.isReady &&
            this.bollinger.isReady
        );
    }

    /**
     * Reset all indicators.
     */
    reset(): void {
        this.sma.reset();
        this.ema.reset();
        this.rsi.reset();
        this.macd.reset();
        this.bollinger.reset();
    }
}

export default IncrementalIndicatorSuite;
