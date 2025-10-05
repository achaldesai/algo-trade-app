import { KiteConnect } from "kiteconnect";
import PaperBroker from "./PaperBroker";
import type BrokerClient from "./BrokerClient";
import type {
  BrokerOrderExecution,
  BrokerOrderRequest,
  BrokerOrderQuote,
  Trade,
  TradeSide,
} from "../types";
import type { Connect, Trade as KiteTrade } from "kiteconnect/types/connect";
import logger from "../utils/logger";

export interface ZerodhaBrokerConfig {
  apiKey: string;
  apiSecret?: string;
  accessToken?: string;
  requestToken?: string;
  defaultExchange: string;
  product: string;
}

interface ZerodhaBrokerDependencies {
  createClient: (apiKey: string) => Connect;
  now: () => Date;
}

const DEFAULT_DEPENDENCIES: ZerodhaBrokerDependencies = {
  createClient: (apiKey: string) => new KiteConnect({ api_key: apiKey }),
  now: () => new Date(),
};

const FALLBACK_VALIDITY_MINUTES = 30;

export class ZerodhaBroker implements BrokerClient {
  public readonly name = "zerodha";

  private readonly fallback = new PaperBroker();

  private readonly dependencies: ZerodhaBrokerDependencies;

  private readonly config: ZerodhaBrokerConfig;

  private kite?: Connect;

  private connected = false;

  private kiteSessionActive = false;

  constructor(config: ZerodhaBrokerConfig, dependencies: ZerodhaBrokerDependencies = DEFAULT_DEPENDENCIES) {
    this.config = config;
    this.dependencies = dependencies;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    await this.fallback.connect();

    if (!this.config.apiKey) {
      logger.warn({ broker: this.name }, "Zerodha broker disabled: missing API key, using paper fallback");
      this.connected = true;
      return;
    }

    try {
      this.kite = this.dependencies.createClient(this.config.apiKey);

      if (this.config.accessToken) {
        this.kite.setAccessToken(this.config.accessToken);
        this.kiteSessionActive = true;
      } else if (this.config.requestToken && this.config.apiSecret) {
        try {
          const session = await this.kite.generateSession(this.config.requestToken, this.config.apiSecret);
          this.kite.setAccessToken(session.access_token);
          this.kiteSessionActive = true;
        } catch (error) {
          logger.warn({ err: error }, "Failed to establish Zerodha session via request token");
          this.kiteSessionActive = false;
        }
      }
    } catch (error) {
      logger.error({ err: error }, "Failed to initialise KiteConnect client");
      this.kite = undefined;
      this.kiteSessionActive = false;
    }

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.kiteSessionActive = false;
    this.kite = undefined;
    await this.fallback.disconnect();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getPositions(): Promise<Trade[]> {
    if (this.kiteSessionActive && this.kite) {
      try {
        const trades = await this.kite.getTrades();
        if (Array.isArray(trades) && trades.length > 0) {
          return trades.map((trade) => this.toDomainTrade(trade));
        }
      } catch (error) {
        logger.warn({ err: error }, "Failed to fetch positions from Zerodha, falling back to paper broker");
        // fall back to paper broker below
      }
    }

    return this.fallback.getPositions();
  }

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderExecution> {
    if (this.kiteSessionActive && this.kite) {
      try {
        const params = this.buildOrderParams(order);
        const response = await this.kite.placeOrder(this.kite.VARIETY_REGULAR, params);

        const trades = await this.kite
          .getOrderTrades(response.order_id)
          .catch(() => [] as KiteTrade[]);
        const { filledQuantity, averagePrice, executedAt } = this.summariseTrades(trades, order);

        const status: BrokerOrderExecution["status"] =
          filledQuantity > 0 ? "FILLED" : "PARTIALLY_FILLED";

        const execution: BrokerOrderExecution = {
          id: response.order_id,
          request: order,
          status,
          filledQuantity,
          averagePrice,
          executedAt,
        } satisfies BrokerOrderExecution;

        return execution;
      } catch (error) {
        logger.error({ err: error, symbol: order.symbol, side: order.side }, "Failed to place order via Zerodha, using paper broker");
        // fall back to paper broker below
      }
    }

    return this.fallback.placeOrder(order);
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (this.kiteSessionActive && this.kite) {
      try {
        await this.kite.cancelOrder(this.kite.VARIETY_REGULAR, orderId);
        return;
      } catch (error) {
        logger.warn({ err: error, orderId }, "Failed to cancel Zerodha order, delegating to paper broker");
        // fall back to paper broker below
      }
    }

    await this.fallback.cancelOrder(orderId);
  }

  async getQuote(symbol: string, side: TradeSide): Promise<BrokerOrderQuote | null> {
    if (this.kiteSessionActive && this.kite) {
      try {
        const instrumentKey = `${this.config.defaultExchange}:${symbol}`;
        const quotes = await this.kite.getQuote([instrumentKey]);
        const quote = quotes?.[instrumentKey];

        if (!quote) {
          return this.fallback.getQuote(symbol, side);
        }

        const depthSide = side === "BUY" ? quote.depth.sell : quote.depth.buy;
        const topLevel = depthSide?.[0];
        const limitPrice = topLevel?.price ?? quote.last_price;
        const quantity = topLevel?.quantity ?? quote.last_quantity ?? 1;

        return {
          symbol,
          side,
          limitPrice,
          quantity: Math.max(1, Math.round(quantity)),
          validUntil: new Date(Date.now() + FALLBACK_VALIDITY_MINUTES * 60_000),
        } satisfies BrokerOrderQuote;
      } catch (error) {
        logger.warn({ err: error, symbol }, "Failed to fetch Zerodha quote, using paper broker data");
        // fall back to paper broker below
      }
    }

    return this.fallback.getQuote(symbol, side);
  }

  private buildOrderParams(order: BrokerOrderRequest) {
    if (order.type === "LIMIT" && typeof order.price !== "number") {
      throw new Error(`Limit order for ${order.symbol} requires a price`);
    }

    return {
      exchange: this.config.defaultExchange,
      tradingsymbol: order.symbol,
      transaction_type: order.side,
      quantity: order.quantity,
      product: this.config.product,
      order_type: order.type,
      validity: this.kite?.VALIDITY_DAY ?? "DAY",
      price: order.price,
      tag: order.tag,
    };
  }

  private summariseTrades(trades: KiteTrade[], order: BrokerOrderRequest) {
    if (!trades.length) {
      return {
        filledQuantity: 0,
        averagePrice: order.price ?? 0,
        executedAt: this.dependencies.now(),
      };
    }

    const totals = trades.reduce(
      (acc, trade) => {
        const quantity = typeof trade.quantity === "number" && trade.quantity > 0 ? trade.quantity : trade.filled;
        const price = trade.average_price ?? 0;
        return {
          quantity: acc.quantity + quantity,
          notional: acc.notional + price * quantity,
          lastTimestamp: trade.fill_timestamp ?? trade.exchange_timestamp ?? trade.order_timestamp ?? acc.lastTimestamp,
        };
      },
      { quantity: 0, notional: 0, lastTimestamp: this.dependencies.now() },
    );

    const averagePrice = totals.quantity > 0 ? Number((totals.notional / totals.quantity).toFixed(4)) : order.price ?? 0;

    return {
      filledQuantity: totals.quantity,
      averagePrice,
      executedAt: new Date(totals.lastTimestamp),
    };
  }

  private toDomainTrade(trade: KiteTrade): Trade {
    const quantity = typeof trade.quantity === "number" && trade.quantity > 0 ? trade.quantity : trade.filled;
    const timestamp = trade.fill_timestamp ?? trade.exchange_timestamp ?? trade.order_timestamp ?? this.dependencies.now();

    return {
      id: trade.trade_id ?? trade.order_id,
      symbol: trade.tradingsymbol,
      side: trade.transaction_type as TradeSide,
      quantity,
      price: trade.average_price ?? 0,
      executedAt: new Date(timestamp),
    } satisfies Trade;
  }
}

export default ZerodhaBroker;
