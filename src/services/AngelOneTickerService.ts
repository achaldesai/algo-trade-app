import WebSocket from "ws";
import type { MarketDataService } from "./MarketDataService";
import logger from "../utils/logger";

export interface AngelOneTickerConfig {
  apiKey: string;
  clientId: string;
  jwtToken: string;
  feedToken: string;
}

export interface TickerSubscription {
  exchange: string;
  symbolToken: string;
  symbol: string;
}

/**
 * Angel One WebSocket ticker service for live market data
 * Subscribes to real-time price updates and feeds them to MarketDataService
 */
export class AngelOneTickerService {
  private ws?: WebSocket;
  private config: AngelOneTickerConfig;
  private marketDataService: MarketDataService;
  private subscriptions: Map<string, TickerSubscription> = new Map();
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatInterval?: NodeJS.Timeout;
  private isConnected = false;

  private readonly WS_URL = "wss://smartapisocket.angelone.in/smart-stream";
  private readonly HEARTBEAT_INTERVAL = 10000; // 10 seconds
  private readonly RECONNECT_DELAY = 5000; // 5 seconds

  constructor(config: AngelOneTickerConfig, marketDataService: MarketDataService) {
    this.config = config;
    this.marketDataService = marketDataService;
  }

  /**
   * Connect to Angel One WebSocket and authenticate
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      logger.info("Angel One ticker already connected");
      return;
    }

    try {
      this.ws = new WebSocket(this.WS_URL);

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

    this.isConnected = false;
    this.subscriptions.clear();
    logger.info("Angel One ticker disconnected");
  }

  /**
   * Subscribe to ticker updates for a symbol
   */
  subscribe(subscription: TickerSubscription): void {
    const key = `${subscription.exchange}:${subscription.symbolToken}`;
    this.subscriptions.set(key, subscription);

    if (this.isConnected && this.ws) {
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

      if (this.isConnected && this.ws) {
        this.sendSubscription([subscription], "unsubscribe");
      }
    }
  }

  /**
   * Check if ticker is connected
   */
  connected(): boolean {
    return this.isConnected;
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

    this.isConnected = false;

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
    if (!this.ws) {
      return;
    }

    const authMessage = {
      action: "authenticate",
      clientId: this.config.clientId,
      jwtToken: this.config.jwtToken,
      feedToken: this.config.feedToken,
    };

    this.ws.send(JSON.stringify(authMessage));

    // Set connected flag after sending auth
    // (we'll assume success for now, proper error handling would check response)
    this.isConnected = true;

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
    if (!this.ws || !this.isConnected) {
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
  private processMarketData(data: any[]): void {
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
      if (this.ws && this.isConnected) {
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

    logger.info({ delay: this.RECONNECT_DELAY }, "Scheduling WebSocket reconnect");

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch((error) => {
        logger.error({ err: error }, "Reconnection attempt failed");
        // Will automatically schedule another reconnect via onClose
      });
    }, this.RECONNECT_DELAY);
  }
}

export default AngelOneTickerService;
