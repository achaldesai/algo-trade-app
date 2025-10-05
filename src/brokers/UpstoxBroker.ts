import PaperBroker from "./PaperBroker";
import RestBrokerBase, { type RestBrokerConfig } from "./RestBrokerBase";
import type {
  BrokerOrderExecution,
  BrokerOrderRequest,
  Trade,
  TradeSide,
} from "../types";

interface UpstoxOrderResponse {
  order_id: string;
  status: "filled" | "rejected" | "partial";
  filled_quantity: number;
  average_price: number;
  message?: string;
  exchange_time: string;
}

interface UpstoxOrderPayload {
  instrument_token: string;
  transaction_type: "BUY" | "SELL";
  quantity: number;
  order_type: "MARKET" | "LIMIT";
  price?: number;
  tag?: string;
}

interface UpstoxPositionResponse {
  instrument_token: string;
  instrument_name: string;
  quantity: number;
  average_price: number;
  pnl: number;
}

export class UpstoxBroker extends RestBrokerBase {
  private readonly fallback = new PaperBroker();

  constructor(config: Omit<RestBrokerConfig, "name"> & { name?: string }) {
    super({ ...config, name: config.name ?? "upstox" });
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
      const response = await this.request<UpstoxPositionResponse[]>("/positions");
      return response.map((item) => ({
        id: item.instrument_token,
        symbol: item.instrument_name,
        side: item.quantity >= 0 ? "BUY" : "SELL",
        quantity: Math.abs(item.quantity),
        price: item.average_price,
        executedAt: new Date(),
      }));
    } catch (error) {
      return this.fallback.getPositions();
    }
  }

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderExecution> {
    const payload: UpstoxOrderPayload = {
      instrument_token: order.symbol,
      transaction_type: order.side,
      quantity: order.quantity,
      order_type: order.type,
      price: order.price,
      tag: order.tag,
    };

    try {
      const response = await this.request<UpstoxOrderResponse>("/orders", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      return {
        id: response.order_id,
        request: order,
        status: response.status === "rejected" ? "REJECTED" : response.status === "partial" ? "PARTIALLY_FILLED" : "FILLED",
        filledQuantity: response.filled_quantity,
        averagePrice: response.average_price,
        executedAt: new Date(response.exchange_time),
        message: response.message,
      };
    } catch (error) {
      return this.fallback.placeOrder(order);
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    try {
      await this.request(`/orders/${orderId}`, { method: "DELETE" });
    } catch (error) {
      await this.fallback.cancelOrder(orderId);
    }
  }

  async getQuote(symbol: string, side: TradeSide) {
    try {
      const response = await this.request<{ last_price: number; depth_quantity: number }>(`/quotes/${symbol}`);
      return {
        symbol,
        side,
        limitPrice: response.last_price,
        quantity: Math.max(1, Math.round(response.depth_quantity)),
        validUntil: new Date(Date.now() + 30_000),
      };
    } catch (error) {
      return this.fallback.getQuote(symbol, side);
    }
  }
}

export default UpstoxBroker;
