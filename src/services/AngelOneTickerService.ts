import WebSocket from "ws";
import type { MarketDataService } from "./MarketDataService";
import type { TickerClient, TickerSubscription } from "./TickerClient";
import logger from "../utils/logger";
import { loadAngelToken } from "../routes/auth";

interface AngelOneTickMessage {
  exchange: string;
  symbolToken: string;
  ltp?: number;
  lastPrice?: number;
  volume?: number;
  [key: string]: unknown;
}

/**
 * Angel One WebSocket ticker service for live market data
 * Subscribes to real-time price updates and feeds them to MarketDataService
 */
export class AngelOneTickerService implements TickerClient {
  private ws?: WebSocket;
  private marketDataService: MarketDataService;
  private subscriptions: Map<string, TickerSubscription> = new Map();
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatInterval?: NodeJS.Timeout;
  private _connected = false;
  private currentTokens?: { clientId: string; jwtToken: string; feedToken: string };
  private reconnectAttempts = 0;

  private readonly WS_URL = "wss://smartapisocket.angelone.in/smart-stream";
  private readonly HEARTBEAT_INTERVAL = 10000; // 10 seconds
  private readonly RECONNECT_DELAY = 5000; // 5 seconds
  private readonly MAX_RECONNECT_ATTEMPTS = 10; // Stop retrying after 10 failures

  constructor(marketDataService: MarketDataService) {
    this.marketDataService = marketDataService;
  }

  /**
   * Connect to Angel One WebSocket and authenticate
   */
  async connect(): Promise<void> {
    if (this._connected) {
      logger.info("Angel One ticker already connected");
      return;
    }

    try {
      // Load latest tokens
      const tokenData = await loadAngelToken();
      if (!tokenData) {
        throw new Error("No Angel One tokens found. Cannot connect ticker.");
      }

      this.currentTokens = {
        clientId: tokenData.clientId,
        jwtToken: tokenData.jwtToken,
        feedToken: tokenData.feedToken,
      };

      // Get API key from env
      const apiKey = process.env.ANGEL_ONE_API_KEY || "";

      // Angel One SmartAPI WebSocket requires headers during handshake
      const wsOptions = {
        headers: {
          "Authorization": `Bearer ${tokenData.jwtToken}`,
          "x-api-key": apiKey,
          "x-client-code": tokenData.clientId,
          "x-feed-token": tokenData.feedToken,
        }
      };

      this.ws = new WebSocket(this.WS_URL, wsOptions);

      this.ws.on("open", () => this.onOpen());
      this.ws.on("message", (data) => this.onMessage(data));
      this.ws.on("error", (error) => this.onError(error));
      this.ws.on("close", () => this.onClose());

      logger.info("Connecting to Angel One WebSocket ticker...");
    } catch (error) {
      logger.error({ err: error }, "Failed to connect to Angel One WebSocket");
      throw error;
    }
  }

  /**
   * Disconnect from WebSocket
   */
  async disconnect(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }

    this._connected = false;
    this.subscriptions.clear();
    logger.info("Angel One ticker disconnected");
  }

  /**
   * Subscribe to ticker updates for a symbol
   */
  subscribe(subscription: TickerSubscription): void {
    const key = `${subscription.exchange}:${subscription.symbolToken}`;
    this.subscriptions.set(key, subscription);

    if (this._connected && this.ws) {
      this.sendSubscription([subscription], "subscribe");
    }
  }

  /**
   * Unsubscribe from ticker updates for a symbol
   */
  unsubscribe(exchange: string, symbolToken: string): void {
    const key = `${exchange}:${symbolToken}`;
    const subscription = this.subscriptions.get(key);

    if (subscription) {
      this.subscriptions.delete(key);

      if (this._connected && this.ws) {
        this.sendSubscription([subscription], "unsubscribe");
      }
    }
  }

  /**
   * Check if ticker is connected
   * Implements TickerClient.isConnected()
   */
  isConnected(): boolean {
    return this._connected;
  }

  /**
   * Handle WebSocket open event
   */
  private onOpen(): void {
    logger.info("Angel One WebSocket connected");

    // Authenticate
    this.authenticate();

    // Start heartbeat
    this.startHeartbeat();
  }

  /**
   * Handle WebSocket message event
   */
  private onMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());

      // Handle different message types
      if (message.action === "heartbeat") {
        // Heartbeat acknowledgment
        return;
      }

      if (message.action === "subscribe" || message.action === "unsubscribe") {
        logger.debug({ action: message.action }, "Subscription action completed");
        return;
      }

      // Market data update
      if (message.data && Array.isArray(message.data)) {
        this.processMarketData(message.data);
      }
    } catch (error) {
      logger.error({ err: error, data: data.toString() }, "Error processing WebSocket message");
    }
  }

  /**
   * Handle WebSocket error event
   */
  private onError(error: Error): void {
    logger.error({ err: error }, "Angel One WebSocket error");
  }

  /**
   * Handle WebSocket close event
   */
  private onClose(): void {
    logger.warn("Angel One WebSocket connection closed");

    this._connected = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Attempt to reconnect
    this.scheduleReconnect();
  }

  /**
   * Authenticate with Angel One WebSocket
   */
  private authenticate(): void {
    if (!this.ws || !this.currentTokens) {
      return;
    }

    const authMessage = {
      action: "authenticate",
      clientId: this.currentTokens.clientId,
      jwtToken: this.currentTokens.jwtToken,
      feedToken: this.currentTokens.feedToken,
    };

    this.ws.send(JSON.stringify(authMessage));

    // Set connected flag after sending auth
    // (we'll assume success for now, proper error handling would check response)
    this._connected = true;

    // Reset retry counter on successful connection
    this.reconnectAttempts = 0;

    // Resubscribe to all previous subscriptions
    if (this.subscriptions.size > 0) {
      this.sendSubscription(Array.from(this.subscriptions.values()), "subscribe");
    }

    logger.info("Angel One WebSocket authenticated");
  }

  /**
   * Send subscription/unsubscription message
   */
  private sendSubscription(
    subscriptions: TickerSubscription[],
    action: "subscribe" | "unsubscribe"
  ): void {
    if (!this.ws || !this._connected) {
      logger.warn("Cannot send subscription: WebSocket not connected");
      return;
    }

    const message = {
      action,
      mode: "FULL", // FULL mode includes depth data
      exchangeType: subscriptions.map((sub) => sub.exchange),
      tokens: subscriptions.map((sub) => sub.symbolToken),
    };

    this.ws.send(JSON.stringify(message));

    logger.info(
      { action, count: subscriptions.length },
      "Sent subscription message to Angel One"
    );
  }

  /**
   * Process market data updates
   */
  private processMarketData(data: AngelOneTickMessage[]): void {
    for (const tick of data) {
      try {
        // Find the subscription for this tick
        const key = `${tick.exchange}:${tick.symbolToken}`;
        const subscription = this.subscriptions.get(key);

        if (!subscription) {
          continue;
        }

        // Update market data service
        this.marketDataService.updateTick({
          symbol: subscription.symbol,
          price: tick.ltp || tick.lastPrice || 0,
          volume: tick.volume || 0,
          timestamp: new Date(),
        });

        logger.debug(
          { symbol: subscription.symbol, price: tick.ltp, volume: tick.volume },
          "Market data updated"
        );
      } catch (error) {
        logger.error({ err: error, tick }, "Error processing market tick");
      }
    }
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this._connected) {
        try {
          this.ws.send(
            JSON.stringify({
              action: "heartbeat",
            })
          );
        } catch (error) {
          logger.error({ err: error }, "Error sending heartbeat");
        }
      }
    }, this.HEARTBEAT_INTERVAL);
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    // Check if max retries exceeded
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logger.error(
        { attempts: this.reconnectAttempts },
        "Max reconnection attempts reached. Stopping ticker reconnection. Check credentials and restart server."
      );
      return;
    }

    this.reconnectAttempts++;

    // Exponential backoff: 5s, 10s, 20s, 40s... (capped at 5 minutes)
    const delay = Math.min(
      this.RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1),
      5 * 60 * 1000
    );

    logger.info(
      { delay, attempt: this.reconnectAttempts, maxAttempts: this.MAX_RECONNECT_ATTEMPTS },
      "Scheduling WebSocket reconnect"
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch((error) => {
        logger.error({ err: error }, "Reconnection attempt failed");
        // Schedule next attempt with backoff (onClose will also call this)
        this.scheduleReconnect();
      });
    }, delay);
  }
}

export default AngelOneTickerService;
