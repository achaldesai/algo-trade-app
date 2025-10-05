import type { BrokerOrderExecution, BrokerOrderRequest, Trade } from "../types";
import type BrokerClient from "./BrokerClient";

export interface RestBrokerConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
}

export abstract class RestBrokerBase implements BrokerClient {
  private connected = false;

  protected constructor(protected readonly config: RestBrokerConfig) {}

  get name(): string {
    return this.config.name;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  abstract getPositions(): Promise<Trade[]>;

  abstract placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderExecution>;

  abstract cancelOrder(orderId: string): Promise<void>;

  abstract getQuote(symbol: string, side: "BUY" | "SELL"): Promise<{
    symbol: string;
    side: "BUY" | "SELL";
    limitPrice?: number;
    quantity: number;
    validUntil: Date;
  } | null>;

  protected async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Broker API error (${response.status}): ${text}`);
    }

    return (await response.json()) as T;
  }
}

export default RestBrokerBase;
