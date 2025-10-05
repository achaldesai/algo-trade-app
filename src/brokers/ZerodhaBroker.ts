import PaperBroker from "./PaperBroker";
import RestBrokerBase, { type RestBrokerConfig } from "./RestBrokerBase";
import type {
  BrokerOrderExecution,
  BrokerOrderRequest,
  Trade,
  TradeSide,
} from "../types";

interface ZerodhaOrderResponse {
  order_id: string;
  status: "COMPLETE" | "REJECTED" | "OPEN";
  filled_quantity: number;
  average_price: number;
  order_timestamp: string;
  status_message?: string;
}

interface ZerodhaQuoteResponse {
  last_price: number;
  tradable_quantity: number;
}

interface ZerodhaPositionResponse {
  tradingsymbol: string;
  net_quantity: number;
  average_price: number;
  pnl: number;
}

export class ZerodhaBroker extends RestBrokerBase {
  private readonly fallback = new PaperBroker();

  constructor(config: Omit<RestBrokerConfig, "name"> & { name?: string }) {
    super({ ...config, name: config.name ?? "zerodha" });
  }

  override async connect(): Promise<void> {
    await super.connect();
    await this.fallback.connect();
  }

  override async disconnect(): Promise<void> {
    await super.disconnect();
    await this.fallback.disconnect();
  }

  async getPositions(): Promise<Trade[]> {
    try {
      const response = await this.request<ZerodhaPositionResponse[]>("/portfolio/positions");
      return response.map((item) => ({
        id: item.tradingsymbol,
        symbol: item.tradingsymbol,
        side: item.net_quantity >= 0 ? "BUY" : "SELL",
        quantity: Math.abs(item.net_quantity),
        price: item.average_price,
        executedAt: new Date(),
      }));
    } catch (_error) {
      return this.fallback.getPositions();
    }
  }

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderExecution> {
    try {
      const response = await this.request<ZerodhaOrderResponse>("/orders", {
        method: "POST",
        body: JSON.stringify({
          tradingsymbol: order.symbol,
          transaction_type: order.side,
          quantity: order.quantity,
          order_type: order.type,
          price: order.price,
          tag: order.tag,
        }),
      });

      return {
        id: response.order_id,
        request: order,
        status: response.status === "REJECTED" ? "REJECTED" : response.status === "OPEN" ? "PARTIALLY_FILLED" : "FILLED",
        filledQuantity: response.filled_quantity,
        averagePrice: response.average_price,
        executedAt: new Date(response.order_timestamp),
        message: response.status_message,
      };
    } catch (_error) {
      return this.fallback.placeOrder(order);
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    try {
      await this.request(`/orders/${orderId}`, { method: "DELETE" });
    } catch (_error) {
      await this.fallback.cancelOrder(orderId);
    }
  }

  async getQuote(symbol: string, side: TradeSide) {
    try {
      const response = await this.request<ZerodhaQuoteResponse>(`/market/quotes/${symbol}`);
      return {
        symbol,
        side,
        limitPrice: response.last_price,
        quantity: Math.max(1, Math.round(response.tradable_quantity)),
        validUntil: new Date(Date.now() + 30_000),
      };
    } catch (_error) {
      return this.fallback.getQuote(symbol, side);
    }
  }
}

export default ZerodhaBroker;
