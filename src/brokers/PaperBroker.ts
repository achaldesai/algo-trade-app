import { randomUUID } from "crypto";
import type BrokerClient from "./BrokerClient";
import type {
  BrokerOrderExecution,
  BrokerOrderRequest,
  BrokerOrderQuote,
  Trade,
  TradeSide,
} from "../types";

interface PaperTrade extends Trade {
  brokerOrderId: string;
}

const MARKET_SLIPPAGE_BPS = 5; // 0.05%

export class PaperBroker implements BrokerClient {
  public readonly name = "paper";

  private connected = false;

  private readonly trades: PaperTrade[] = [];

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getPositions(): Promise<Trade[]> {
    return this.trades.map(({ brokerOrderId: _omit, ...trade }) => trade);
  }

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderExecution> {
    if (!this.connected) {
      throw new Error("Paper broker is not connected");
    }

    const executionPrice = this.estimateFillPrice(order);
    const trade: PaperTrade = {
      id: randomUUID(),
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      price: executionPrice,
      executedAt: new Date(),
      brokerOrderId: randomUUID(),
    };

    this.trades.push(trade);

    return {
      id: trade.brokerOrderId,
      request: order,
      status: "FILLED",
      filledQuantity: order.quantity,
      averagePrice: executionPrice,
      executedAt: trade.executedAt,
    } satisfies BrokerOrderExecution;
  }

  async cancelOrder(orderId: string): Promise<void> {
    // Paper broker assumes immediate fill; nothing to cancel
    const stillExists = this.trades.some((trade) => trade.brokerOrderId === orderId);
    if (!stillExists) {
      throw new Error(`Unknown paper order ${orderId}`);
    }
  }

  async getQuote(symbol: string, side: TradeSide): Promise<BrokerOrderQuote | null> {
    const matches = this.trades.filter((trade) => trade.symbol === symbol);
    if (matches.length === 0) {
      return null;
    }

    const lastTrade = matches[matches.length - 1];
    const adjustment = side === "BUY" ? 1 + MARKET_SLIPPAGE_BPS / 10_000 : 1 - MARKET_SLIPPAGE_BPS / 10_000;
    const price = Number((lastTrade.price * adjustment).toFixed(4));

    return {
      symbol,
      side,
      limitPrice: price,
      quantity: Math.max(lastTrade.quantity, 1),
      validUntil: new Date(Date.now() + 60_000),
    };
  }

  reset(): void {
    this.trades.length = 0;
  }

  private estimateFillPrice(order: BrokerOrderRequest): number {
    if (order.type === "LIMIT" && order.price) {
      return order.price;
    }

    const reference = this.trades
      .filter((item) => item.symbol === order.symbol && item.side === order.side)
      .map((item) => item.price)
      .at(-1);
    if (!reference) {
      return Number((Math.random() * 100 + 50).toFixed(2));
    }

    const direction = order.side === "BUY" ? 1 : -1;
    const slippage = direction * (MARKET_SLIPPAGE_BPS / 10_000) * reference;
    return Number((reference + slippage).toFixed(4));
  }
}

export default PaperBroker;
