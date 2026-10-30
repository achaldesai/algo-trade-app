import { WebSocketV2 } from "smartapi-javascript";
import type { WebSocketV2QuoteTick, WebSocketV2Tick } from "smartapi-javascript";
import type { MarketDataService } from "./MarketDataService";
import type { TickerClient, TickerSubscription } from "./TickerClient";
import type { TokenRepo } from "../db/repositories/TokenRepo";
import logger from "../utils/logger";

const QUOTE_MODE = 2 as const;
const SUBSCRIBE = 1 as const;
const UNSUBSCRIBE = 0 as const;

const EXCHANGE_TYPE: Record<string, number> = {
  NSE: 1,
  NSE_CM: 1,
  NSE_FO: 2,
  BSE: 3,
  BSE_CM: 3,
  BSE_FO: 4,
  MCX: 5,
  NCX: 7,
  CDE: 13,
};

// NSE equity session: 09:15 IST open, 15:30 IST close. We want the WS up
// 10 min before open so subscribes are in place when the first ticks fire.
const SESSION_OPEN_HOUR_IST = 9;
const SESSION_OPEN_MINUTE_IST = 5;   // 09:15 - 10 min
const SESSION_CLOSE_HOUR_IST = 15;
const SESSION_CLOSE_MINUTE_IST = 30;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 5_000;

type WebSocketV2Params = ConstructorParameters<typeof WebSocketV2>[0];
type WebSocketV2Instance = InstanceType<typeof WebSocketV2>;

export interface AngelOneTickerDependencies {
  createWebSocket?: (params: WebSocketV2Params) => WebSocketV2Instance;
  connectTimeoutMs?: number;
}

export class AngelOneTickerService implements TickerClient {
  private ws?: WebSocketV2Instance;
  private readonly marketDataService: MarketDataService;
  private readonly tokenRepo: TokenRepo;
  private readonly createWebSocket: (
    params: WebSocketV2Params,
  ) => WebSocketV2Instance;
  private readonly connectTimeoutMs: number;
  // The smartapi-javascript SDK stores its event handlers in a shared
  // module-level `triggers` array and has no `off()`. Registering `on("tick")`
  // on every connection instance would leak a handler, so ticks would be
  // processed once per connection. Instead we register the handler exactly
  // once on this dedicated "handler owner" instance, which is never connected.
  private readonly handlerOwner: WebSocketV2Instance;
  private readonly subscriptions = new Map<string, TickerSubscription>();
  private _connected = false;
  private tickCount = 0;
  private statsInterval?: NodeJS.Timeout;
  private sessionTimer?: NodeJS.Timeout;
  private stopped = false;
  private readonly TICK_STATS_INTERVAL = 30_000;

  constructor(
    marketDataService: MarketDataService,
    tokenRepo: TokenRepo,
    dependencies: AngelOneTickerDependencies = {},
  ) {
    this.marketDataService = marketDataService;
    this.tokenRepo = tokenRepo;
    this.createWebSocket =
      dependencies.createWebSocket ??
      ((params: WebSocketV2Params) => new WebSocketV2(params));
    this.connectTimeoutMs =
      dependencies.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    this.handlerOwner = this.createWebSocket({
      clientcode: "",
      jwttoken: "",
      apikey: "",
      feedtype: "",
    });
    this.handlerOwner.on("tick", (data) => this.onTick(data));
  }

  async connect(): Promise<void> {
    this.stopped = false;
    const now = new Date();

    if (this.isInTickerSession(now)) {
      await this.openWebSocket();
      this.scheduleNextClose(now);
    } else {
      this.scheduleNextOpen(now);
    }
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.cancelSessionTimer();
    await this.closeWebSocket();
    this.subscriptions.clear();
    logger.info("Angel One ticker disconnected");
  }

  private async openWebSocket(): Promise<void> {
    if (this._connected) {
      logger.info("Angel One ticker already connected");
      return;
    }

    const tokenData = this.tokenRepo.getAngelOneToken("SYSTEM_DEFAULT");
    if (!tokenData) {
      throw new Error("No Angel One tokens found. Cannot connect ticker.");
    }
    const apiKey = process.env.ANGEL_ONE_API_KEY;
    if (!apiKey) {
      throw new Error("ANGEL_ONE_API_KEY env var is required for the ticker.");
    }

    const ws = this.createWebSocket({
      clientcode: tokenData.clientId,
      jwttoken: tokenData.jwtToken,
      apikey: apiKey,
      feedtype: tokenData.feedToken,
    });
    this.ws = ws;

    // Never register `on("tick")` here: the handler owner does that once.
    // With a custom error handler the SDK rejects connect() on a refused /
    // 401 handshake instead of `throw`-ing out of onerror (an uncaught crash).
    ws.customError();
    // Bounded reconnect: fixed delay that never grows (unlike "exponential").
    ws.reconnection("simple", RECONNECT_DELAY_MS);

    logger.info("Connecting to Angel One WebSocket ticker...");
    await this.withTimeout(ws.connect(), this.connectTimeoutMs, () => {
      logger.warn(
        { timeoutMs: this.connectTimeoutMs },
        "Angel One WebSocket connect timed out",
      );
      try {
        ws.close();
      } catch (err) {
        logger.warn({ err }, "Error closing Angel One WebSocket after timeout");
      }
    });
    this._connected = true;
    logger.info("Angel One WebSocket connected");

    this.startStatsInterval();

    if (this.subscriptions.size > 0) {
      this.flushSubscriptions(Array.from(this.subscriptions.values()), SUBSCRIBE);
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    onTimeout: () => void,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(
          new Error(`Angel One WebSocket connect timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async closeWebSocket(): Promise<void> {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = undefined;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch (err) {
        logger.warn({ err }, "Error closing Angel One WebSocket");
      }
      this.ws = undefined;
    }
    this._connected = false;
  }

  subscribe(subscription: TickerSubscription): void {
    const exchangeType = this.exchangeTypeFor(subscription.exchange);
    if (exchangeType === undefined) {
      logger.warn(
        { exchange: subscription.exchange, symbol: subscription.symbol },
        "Skipping ticker subscription: unknown exchange",
      );
      return;
    }

    const key = this.subscriptionKey(exchangeType, subscription.symbolToken);
    this.subscriptions.set(key, subscription);

    if (this._connected && this.ws) {
      this.flushSubscriptions([subscription], SUBSCRIBE);
    }
  }

  unsubscribe(exchange: string, symbolToken: string): void {
    const exchangeType = this.exchangeTypeFor(exchange);
    if (exchangeType === undefined) return;

    const key = this.subscriptionKey(exchangeType, symbolToken);
    const subscription = this.subscriptions.get(key);
    if (!subscription) return;

    this.subscriptions.delete(key);
    if (this._connected && this.ws) {
      this.flushSubscriptions([subscription], UNSUBSCRIBE);
    }
  }

  isConnected(): boolean {
    return this._connected;
  }

  private flushSubscriptions(
    subs: TickerSubscription[],
    action: typeof SUBSCRIBE | typeof UNSUBSCRIBE,
  ): void {
    if (!this.ws) return;

    const byExchange = new Map<number, string[]>();
    for (const sub of subs) {
      const exchangeType = this.exchangeTypeFor(sub.exchange);
      if (exchangeType === undefined) continue;
      const tokens = byExchange.get(exchangeType) ?? [];
      tokens.push(sub.symbolToken);
      byExchange.set(exchangeType, tokens);
    }

    for (const [exchangeType, tokens] of byExchange) {
      this.ws.fetchData({ action, mode: QUOTE_MODE, exchangeType, tokens });
      logger.info(
        { action, exchangeType, count: tokens.length },
        "Sent subscription message to Angel One",
      );
    }
  }

  private onTick(data: WebSocketV2Tick): void {
    if (typeof data === "string" || !this.isQuoteTick(data)) {
      return;
    }

    this.tickCount += 1;

    const exchangeType = Number(data.exchange_type);
    const token = this.cleanToken(data.token);
    const key = this.subscriptionKey(exchangeType, token);
    const subscription = this.subscriptions.get(key);
    if (!subscription) return;

    const lastTradedPrice = Number(data.last_traded_price);
    if (!Number.isFinite(lastTradedPrice) || lastTradedPrice <= 0) {
      return;
    }

    const ltp = lastTradedPrice / 100;
    const avgPrice = Number(data.avg_traded_price) / 100;
    const volume = Number(data.vol_traded);

    this.marketDataService.updateTick({
      symbol: subscription.symbol,
      price: ltp,
      volume: Number.isFinite(volume) ? volume : 0,
      averagePrice: Number.isFinite(avgPrice) ? avgPrice : undefined,
      timestamp: new Date(),
    });
  }

  private isQuoteTick(data: WebSocketV2Tick): data is WebSocketV2QuoteTick {
    return (
      typeof data === "object" &&
      data !== null &&
      "last_traded_price" in data &&
      "token" in data
    );
  }

  // The SDK's binary parser returns the token as a JSON-stringified, null-padded
  // string (e.g. `"\"3045\""`). Strip the JSON quotes to get the bare token.
  private cleanToken(raw: string): string {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : raw;
    } catch {
      return raw;
    }
  }

  private exchangeTypeFor(exchange: string): number | undefined {
    return EXCHANGE_TYPE[exchange.toUpperCase()];
  }

  private subscriptionKey(exchangeType: number, token: string): string {
    return `${exchangeType}:${token}`;
  }

  private startStatsInterval(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }
    this.tickCount = 0;
    this.statsInterval = setInterval(() => {
      if (this.subscriptions.size > 0) {
        logger.info(
          {
            ticksReceived: this.tickCount,
            subscribedSymbols: this.subscriptions.size,
          },
          "Live ticker active",
        );
      }
      this.tickCount = 0;
    }, this.TICK_STATS_INTERVAL);
  }

  private isInTickerSession(date: Date): boolean {
    const ist = new Date(date.getTime() + IST_OFFSET_MS);
    const day = ist.getUTCDay();
    if (day === 0 || day === 6) return false;
    const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const open = SESSION_OPEN_HOUR_IST * 60 + SESSION_OPEN_MINUTE_IST;
    const close = SESSION_CLOSE_HOUR_IST * 60 + SESSION_CLOSE_MINUTE_IST;
    return minutes >= open && minutes <= close;
  }

  private nextSessionOpen(now: Date): Date {
    return this.nextIstWeekdayAt(
      now,
      SESSION_OPEN_HOUR_IST,
      SESSION_OPEN_MINUTE_IST,
    );
  }

  private nextSessionClose(now: Date): Date {
    return this.nextIstWeekdayAt(
      now,
      SESSION_CLOSE_HOUR_IST,
      SESSION_CLOSE_MINUTE_IST,
    );
  }

  private nextIstWeekdayAt(now: Date, hourIst: number, minuteIst: number): Date {
    const ist = new Date(now.getTime() + IST_OFFSET_MS);
    const candidateIstMs = Date.UTC(
      ist.getUTCFullYear(),
      ist.getUTCMonth(),
      ist.getUTCDate(),
      hourIst,
      minuteIst,
      0,
      0,
    );
    let utcMs = candidateIstMs - IST_OFFSET_MS;

    while (utcMs <= now.getTime() || this.isWeekendUtc(utcMs)) {
      utcMs += 24 * 60 * 60 * 1000;
    }
    return new Date(utcMs);
  }

  private isWeekendUtc(utcMs: number): boolean {
    const day = new Date(utcMs + IST_OFFSET_MS).getUTCDay();
    return day === 0 || day === 6;
  }

  private scheduleNextOpen(now: Date): void {
    this.cancelSessionTimer();
    if (this.stopped) return;
    const target = this.nextSessionOpen(now);
    const delay = Math.max(0, target.getTime() - now.getTime());
    logger.info(
      { nextOpenAt: target.toISOString() },
      "Ticker outside session window, scheduling next open",
    );
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = undefined;
      void this.runSessionOpen();
    }, delay);
  }

  private scheduleNextClose(now: Date): void {
    this.cancelSessionTimer();
    if (this.stopped) return;
    const target = this.nextSessionClose(now);
    const delay = Math.max(0, target.getTime() - now.getTime());
    logger.info(
      { nextCloseAt: target.toISOString() },
      "Ticker session active, scheduling close",
    );
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = undefined;
      void this.runSessionClose();
    }, delay);
  }

  private async runSessionOpen(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.openWebSocket();
      this.scheduleNextClose(new Date());
    } catch (err) {
      logger.error({ err }, "Failed to open ticker for new session, retrying in 60s");
      this.sessionTimer = setTimeout(() => {
        this.sessionTimer = undefined;
        void this.runSessionOpen();
      }, 60_000);
    }
  }

  private async runSessionClose(): Promise<void> {
    logger.info("Ticker session ended, closing WebSocket until next session");
    await this.closeWebSocket();
    if (!this.stopped) {
      this.scheduleNextOpen(new Date());
    }
  }

  private cancelSessionTimer(): void {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = undefined;
    }
  }
}

export default AngelOneTickerService;
