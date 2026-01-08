import axios from "axios";
import { authenticator } from "otplib";
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
import type {
  Connect,
  Trade as KiteTrade,
  Exchanges,
  Product as KiteProduct,
  OrderType as KiteOrderType,
  Validity as KiteValidity,
  TransactionType,
} from "kiteconnect/types/connect";
import logger from "../utils/logger";
import env from "../config/env";
import { getTokenRepository, type ZerodhaTokenData } from "../persistence/TokenRepository";

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
        logger.info({ broker: this.name }, "Zerodha session established via access token");
      } else if (this.config.requestToken && this.config.apiSecret) {
        try {
          const session = await this.kite.generateSession(this.config.requestToken, this.config.apiSecret);
          this.kite.setAccessToken(session.access_token);
          this.kiteSessionActive = true;
          logger.info({ broker: this.name }, "Zerodha session established via request token");
        } catch (error) {
          logger.warn({ err: error }, "Failed to establish Zerodha session via request token");
          this.kiteSessionActive = false;
        }
      } else if (env.zerodhaUserId && env.zerodhaPassword && env.zerodhaTotpSecret && this.config.apiSecret) {
        try {
          logger.info({ broker: this.name }, "Attempting automated Zerodha login with TOTP");
          const session = await this.getAutomatedSession();
          if (session?.access_token) {
            this.kite.setAccessToken(session.access_token);
            this.kiteSessionActive = true;

            // Save the token to the repository so dashboard reports correct status
            const now = new Date();
            const expiryDate = new Date(now);
            expiryDate.setUTCHours(0, 30, 0, 0); // 6 AM IST = 00:30 UTC
            if (expiryDate <= now) {
              expiryDate.setDate(expiryDate.getDate() + 1);
            }

            const tokenData: ZerodhaTokenData = {
              accessToken: session.access_token,
              expiresAt: expiryDate.toISOString(),
              userId: env.zerodhaUserId,
              apiKey: this.config.apiKey,
            };

            try {
              const tokenRepo = getTokenRepository(env.portfolioStorePath);
              await tokenRepo.saveZerodhaToken(tokenData);
              process.env.ZERODHA_ACCESS_TOKEN = session.access_token;
            } catch (saveError) {
              logger.warn({ err: saveError }, "Failed to save Zerodha token to repository (non-fatal)");
            }

            logger.info({ broker: this.name, userId: env.zerodhaUserId }, "Zerodha session established via automated login");
          } else {
            logger.error({ broker: this.name }, "Automated login returned no access token. Please authenticate manually via GET /api/auth/zerodha/login");
            this.kiteSessionActive = false;
          }
        } catch (error) {
          logger.error({ err: error, broker: this.name }, "Automated Zerodha login failed. Please authenticate manually via GET /api/auth/zerodha/login");
          this.kiteSessionActive = false;
        }
      } else {
        logger.error({ broker: this.name }, "No valid authentication method available for Zerodha. Please authenticate via GET /api/auth/zerodha/login or set ZERODHA_USER_ID, ZERODHA_PASSWORD, and ZERODHA_TOTP_SECRET for automated login");
        this.kiteSessionActive = false;
      }
    } catch (error) {
      logger.error({ err: error }, "Failed to initialise KiteConnect client");
      this.kite = undefined;
      this.kiteSessionActive = false;
    }

    this.connected = true;
  }

  /**
   * Automated session generation using Zerodha credentials and TOTP secret.
   * This bypasses the need for manual login/callback flow by:
   * 1. Submitting login credentials to get a request_id
   * 2. Submitting TOTP for 2FA verification
   * 3. Extracting request_token from the login redirect
   * 4. Generating final session with access_token
   */
  private async getAutomatedSession(): Promise<{ access_token: string } | null> {
    if (!this.kite || !this.config.apiSecret) {
      return null;
    }

    const instance = axios.create({ withCredentials: true });
    let cookies: string[] = [];

    // 1. Initial login request
    const loginRes = await instance.post(
      "https://kite.zerodha.com/api/login",
      new URLSearchParams({
        user_id: env.zerodhaUserId,
        password: env.zerodhaPassword,
      }).toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const loginCookies = loginRes.headers["set-cookie"];
    if (loginCookies) {
      cookies = cookies.concat(loginCookies);
    }

    const requestId = loginRes.data?.data?.request_id;
    if (!requestId) {
      throw new Error("Login response missing request_id");
    }

    // 2. Two-factor authentication with TOTP
    const totpToken = authenticator.generate(env.zerodhaTotpSecret);
    const twofaRes = await instance.post(
      "https://kite.zerodha.com/api/twofa",
      new URLSearchParams({
        user_id: env.zerodhaUserId,
        request_id: requestId,
        twofa_value: totpToken,
        skip_session: "true",
      }).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookies.join("; "),
        },
      }
    );

    const twofaCookies = twofaRes.headers["set-cookie"];
    if (twofaCookies) {
      cookies = cookies.concat(twofaCookies);
    }

    // 3. Get request_token via login URL redirect chain
    // The flow is: login URL -> /connect/finish -> callback URL with request_token
    // We need to follow redirects manually to maintain cookies
    let currentUrl = this.kite.getLoginURL();
    let requestToken: string | null = null;
    const maxRedirects = 5;

    for (let i = 0; i < maxRedirects; i++) {
      const redirectRes = await instance.get(currentUrl, {
        maxRedirects: 0,
        validateStatus: (status) => status === 302 || status === 200,
        headers: {
          Cookie: cookies.join("; "),
        },
      });

      const newCookies = redirectRes.headers["set-cookie"];
      if (newCookies) {
        cookies = cookies.concat(newCookies);
      }

      const redirectUrl = redirectRes.headers.location;

      if (!redirectUrl) {
        throw new Error(`Redirect chain ended without request_token at ${currentUrl}`);
      }

      try {
        const parsedUrl = new URL(redirectUrl, "https://kite.zerodha.com");
        requestToken = parsedUrl.searchParams.get("request_token");

        if (requestToken) {
          logger.debug({ redirectCount: i + 1 }, "Found request_token in redirect");
          break;
        }
      } catch {
        // URL parsing failed, continue following redirects
      }

      // Follow the redirect
      currentUrl = redirectUrl.startsWith("http")
        ? redirectUrl
        : `https://kite.zerodha.com${redirectUrl}`;

      logger.debug({ redirect: i + 1, url: currentUrl }, "Following redirect");
    }

    if (!requestToken) {
      throw new Error("Failed to extract request_token after following redirect chain");
    }

    // 4. Generate final session
    const session = await this.kite.generateSession(requestToken, this.config.apiSecret);
    logger.debug({ accessToken: session.access_token?.slice(0, 10) + "..." }, "Generated Zerodha access token");

    return session;
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
      }
    }

    return this.fallback.getQuote(symbol, side);
  }

  private buildOrderParams(order: BrokerOrderRequest) {
    if (order.type === "LIMIT" && typeof order.price !== "number") {
      throw new Error(`Limit order for ${order.symbol} requires a price`);
    }

    const exchange = this.config.defaultExchange.toUpperCase() as Exchanges;
    const product = this.config.product.toUpperCase() as KiteProduct;
    const transactionType = order.side as TransactionType;
    const orderType = order.type as KiteOrderType;
    const validity = (this.kite?.VALIDITY_DAY ?? "DAY") as KiteValidity;

    return {
      exchange,
      tradingsymbol: order.symbol,
      transaction_type: transactionType,
      quantity: order.quantity,
      product,
      order_type: orderType,
      validity,
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
