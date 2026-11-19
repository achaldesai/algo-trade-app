import type {
  BrokerOrderExecution,
  BrokerOrderRequest,
  Trade,
  TradeSide,
} from "../types";

export interface BrokerOrderQuote {
  symbol: string;
  side: TradeSide;
  limitPrice?: number;
  quantity: number;
  validUntil: Date;
}

export interface BrokerClient {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getPositions(): Promise<Trade[]>;
  placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderExecution>;
  cancelOrder(orderId: string): Promise<void>;
  getQuote(symbol: string, side: TradeSide): Promise<BrokerOrderQuote | null>;
  /**
   * Cash available to trade with, or null when the broker can't report it.
   * Optional: brokers without it (paper, Angel One) are treated as null.
   */
  getFunds?(): Promise<BrokerFunds | null>;
  /**
   * What the account actually holds, net per symbol (positive = long), or null
   * when the broker can't say. Optional: the paper broker has no state that
   * survives a restart, so the app's own ledger is its truth.
   */
  getHoldings?(): Promise<BrokerHolding[] | null>;
}

export interface BrokerHolding {
  symbol: string;
  quantity: number;
}

export interface BrokerFunds {
  cash: number;
}

export default BrokerClient;
