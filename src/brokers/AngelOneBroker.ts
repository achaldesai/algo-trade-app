import { SmartAPI } from "smartapi-javascript";
import { authenticator } from "otplib";
import PaperBroker from "./PaperBroker";
import type BrokerClient from "./BrokerClient";
import type { BrokerOrderQuote } from "./BrokerClient";
import type {
  BrokerOrderExecution,
  BrokerOrderRequest,
  Trade,
  TradeSide,
} from "../types";
import { getInstrumentMasterService } from "../services/InstrumentMasterService";
import logger from "../utils/logger";

export interface AngelOneBrokerConfig {
  apiKey: string;
  clientId: string;
  password: string;
  totpSecret?: string;
  defaultExchange: string; // NSE, BSE, etc.
  productType: string; // DELIVERY, INTRADAY, MARGIN, etc.
}

interface AngelOneBrokerDependencies {
  createClient: (apiKey: string) => typeof SmartAPI.prototype;
  now: () => Date;
}

const DEFAULT_DEPENDENCIES: AngelOneBrokerDependencies = {
  createClient: (apiKey: string) => new SmartAPI({ api_key: apiKey }),
  now: () => new Date(),
};

const FALLBACK_VALIDITY_MINUTES = 30;

/**
 * Angel One broker implementation with paper trading fallback
 * Provides free order execution for Indian markets via Angel One SmartAPI
 */
export class AngelOneBroker implements BrokerClient {
  public readonly name = "angelone";

  private readonly fallback = new PaperBroker();
  private readonly dependencies: AngelOneBrokerDependencies;
  private readonly config: AngelOneBrokerConfig;

  private smartApi?: typeof SmartAPI.prototype;
  private connected = false;
  private authenticated = false;

  constructor(
    config: AngelOneBrokerConfig,
    dependencies: AngelOneBrokerDependencies = DEFAULT_DEPENDENCIES
  ) {
    this.config = config;
    this.dependencies = dependencies;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    await this.fallback.connect();

    if (!this.config.apiKey || !this.config.clientId || !this.config.password) {
      logger.warn(
        { broker: this.name },
        "Angel One broker disabled: missing credentials, using paper fallback"
      );
      this.connected = true;
      return;
    }

    try {
      this.smartApi = this.dependencies.createClient(this.config.apiKey);

      // Attempt authentication
      await this.authenticate();

      this.connected = true;
      logger.info({ broker: this.name }, "Angel One broker connected successfully");
    } catch (error) {
      logger.error({ err: error }, "Failed to initialize Angel One broker");
      this.smartApi = undefined;
      this.authenticated = false;
      this.connected = true; // Still mark as connected to use fallback
    }
  }

  async disconnect(): Promise<void> {
    if (this.smartApi && this.authenticated) {
      try {
        await this.smartApi.logOut();
      } catch (error) {
        logger.warn({ err: error }, "Error during Angel One logout");
      }
    }

    this.connected = false;
    this.authenticated = false;
    this.smartApi = undefined;
    await this.fallback.disconnect();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getPositions(): Promise<Trade[]> {
    if (this.authenticated && this.smartApi) {
      try {
        const response = await this.smartApi.getPosition();

        if (response.status && Array.isArray(response.data)) {
          return response.data
            .filter((pos: any) => pos.netqty && pos.netqty !== "0")
            .map((pos: any) => this.toDomainTrade(pos));
        }
      } catch (error) {
        logger.warn(
          { err: error },
          "Failed to fetch positions from Angel One, falling back to paper broker"
        );
      }
    }

    return this.fallback.getPositions();
  }

  async placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderExecution> {
    if (this.authenticated && this.smartApi) {
      try {
        const params = this.buildOrderParams(order);
        const response = await this.smartApi.placeOrder(params);

        if (!response.status || !response.data?.orderid) {
          throw new Error(
            `Order placement failed: ${response.message || JSON.stringify(response)}`
          );
        }

        const orderId = response.data.orderid;

        // Fetch order details to get fill information
        const orderDetails = await this.getOrderDetails(orderId);

        const execution: BrokerOrderExecution = {
          id: orderId,
          request: order,
          status: orderDetails.status,
          filledQuantity: orderDetails.filledQuantity,
          averagePrice: orderDetails.averagePrice,
          executedAt: orderDetails.executedAt,
        };

        logger.info(
          { orderId, symbol: order.symbol, side: order.side, status: execution.status },
          "Angel One order executed"
        );

        return execution;
      } catch (error) {
        logger.error(
          { err: error, symbol: order.symbol, side: order.side },
          "Failed to place order via Angel One, using paper broker"
        );
      }
    }

    return this.fallback.placeOrder(order);
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (this.authenticated && this.smartApi) {
      try {
        const response = await this.smartApi.cancelOrder({
          variety: "NORMAL",
          orderid: orderId,
        });

        if (response.status) {
          logger.info({ orderId }, "Angel One order cancelled successfully");
          return;
        }

        throw new Error(`Cancel failed: ${response.message || JSON.stringify(response)}`);
      } catch (error) {
        logger.warn({ err: error, orderId }, "Failed to cancel Angel One order, delegating to paper broker");
      }
    }

    await this.fallback.cancelOrder(orderId);
  }

  async getQuote(symbol: string, side: TradeSide): Promise<BrokerOrderQuote | null> {
    if (this.authenticated && this.smartApi) {
      try {
        // Angel One requires exchange and symbol token
        const symbolToken = await this.getSymbolToken(symbol);

        const response = await this.smartApi.getQuote({
          mode: "FULL",
          exchangeTokens: {
            [this.config.defaultExchange]: [symbolToken],
          },
        });

        if (!response.status || !response.data?.fetched) {
          return this.fallback.getQuote(symbol, side);
        }

        const quoteData = response.data.fetched[0];
        const depth = quoteData.depth;

        // Get best bid/ask based on side
        const price =
          side === "BUY"
            ? depth?.sell?.[0]?.price || quoteData.ltp
            : depth?.buy?.[0]?.price || quoteData.ltp;

        const quantity =
          side === "BUY"
            ? depth?.sell?.[0]?.quantity || 1
            : depth?.buy?.[0]?.quantity || 1;

        return {
          symbol,
          side,
          limitPrice: Number(price),
          quantity: Math.max(1, Math.round(quantity)),
          validUntil: new Date(Date.now() + FALLBACK_VALIDITY_MINUTES * 60_000),
        };
      } catch (error) {
        logger.warn(
          { err: error, symbol },
          "Failed to fetch Angel One quote, using paper broker data"
        );
      }
    }

    return this.fallback.getQuote(symbol, side);
  }

  /**
   * Authenticate with Angel One SmartAPI
   */
  private async authenticate(): Promise<void> {
    if (!this.smartApi) {
      throw new Error("SmartAPI client not initialized");
    }

    try {
      // Generate TOTP if secret is provided
      const totp = this.config.totpSecret
        ? this.generateTOTP(this.config.totpSecret)
        : undefined;

      const response = await this.smartApi.generateSession(
        this.config.clientId,
        this.config.password,
        totp
      );

      if (response.status && response.data?.jwtToken) {
        this.smartApi.setAccessToken(response.data.jwtToken);
        this.authenticated = true;
        logger.info("Angel One authentication successful");
      } else {
        throw new Error("Authentication failed: " + JSON.stringify(response));
      }
    } catch (error) {
      logger.error({ err: error }, "Failed to authenticate with Angel One");
      throw error;
    }
  }

  /**
   * Build order parameters in Angel One format
   */
  private buildOrderParams(order: BrokerOrderRequest): any {
    if (order.type === "LIMIT" && typeof order.price !== "number") {
      throw new Error(`Limit order for ${order.symbol} requires a price`);
    }

    return {
      variety: "NORMAL",
      tradingsymbol: order.symbol,
      symboltoken: this.getSymbolToken(order.symbol), // This needs to be synchronous or cached
      transactiontype: order.side,
      exchange: this.config.defaultExchange,
      ordertype: order.type,
      producttype: this.config.productType,
      duration: "DAY",
      price: order.price ? order.price.toString() : "0",
      quantity: order.quantity.toString(),
      tag: order.tag,
    };
  }

  /**
   * Get order details from Angel One
   */
  private async getOrderDetails(orderId: string): Promise<{
    status: BrokerOrderExecution["status"];
    filledQuantity: number;
    averagePrice: number;
    executedAt: Date;
  }> {
    if (!this.smartApi) {
      throw new Error("SmartAPI client not initialized");
    }

    try {
      const response = await this.smartApi.getOrderBook();

      if (!response.status || !Array.isArray(response.data)) {
        throw new Error("Failed to fetch order book");
      }

      const order = response.data.find((o: any) => o.orderid === orderId);

      if (!order) {
        return {
          status: "REJECTED",
          filledQuantity: 0,
          averagePrice: 0,
          executedAt: this.dependencies.now(),
        };
      }

      const filledQuantity = parseInt(order.filledshares || "0", 10);
      const totalQuantity = parseInt(order.quantity || "0", 10);
      const averagePrice = parseFloat(order.averageprice || "0");

      let status: BrokerOrderExecution["status"] = "REJECTED";
      if (filledQuantity === totalQuantity && filledQuantity > 0) {
        status = "FILLED";
      } else if (filledQuantity > 0) {
        status = "PARTIALLY_FILLED";
      }

      return {
        status,
        filledQuantity,
        averagePrice,
        executedAt: order.updatetime
          ? new Date(order.updatetime)
          : this.dependencies.now(),
      };
    } catch (error) {
      logger.error({ err: error, orderId }, "Failed to get order details");
      throw error;
    }
  }

  /**
   * Convert Angel One position to domain Trade
   */
  private toDomainTrade(position: any): Trade {
    const quantity = Math.abs(parseInt(position.netqty || "0", 10));
    const price = parseFloat(position.netprice || position.avgnetprice || "0");

    return {
      id: position.symboltoken || `${position.tradingsymbol}-${Date.now()}`,
      symbol: position.tradingsymbol,
      side: parseInt(position.netqty) > 0 ? "BUY" : "SELL",
      quantity,
      price,
      executedAt: this.dependencies.now(),
    };
  }

  /**
   * Get symbol token for a given symbol synchronously
   * Uses cached instrument master service
   */
  private getSymbolToken(symbol: string): string {
    const instrumentService = getInstrumentMasterService();

    if (!instrumentService.isReady()) {
      logger.error({ symbol }, "Instrument master not loaded");
      throw new Error("Instrument master not loaded. Call loadInstrumentMaster() at startup.");
    }

    const token = instrumentService.getToken(symbol, this.config.defaultExchange);

    if (!token) {
      logger.error({ symbol }, "Symbol token not found");
      throw new Error(`Symbol token not found for ${symbol}`);
    }

    return token;
  }

  /**
   * Generate TOTP for two-factor authentication
   */
  private generateTOTP(secret: string): string {
    try {
      const token = authenticator.generate(secret);
      logger.debug("TOTP generated successfully");
      return token;
    } catch (error) {
      logger.error({ err: error }, "Failed to generate TOTP");
      throw new Error("Failed to generate TOTP code");
    }
  }
}

export default AngelOneBroker;
