import logger from "../utils/logger";
import { MarketScannerService } from "./MarketScannerService";
import { TradingLoopService } from "./TradingLoopService";
import type TickerClient from "./TickerClient";
import { StopLossMonitor } from "./StopLossMonitor";
import PortfolioService from "./PortfolioService";
import type { UserRepo } from "../db/repositories/UserRepo";

/**
 * AutoTradingService automates the daily trading lifecycle:
 * 1. Scan market for picks at opening
 * 2. Subscribe to picked stocks
 * 3. Start trading loop and stop-loss monitoring
 * 4. Periodically rotate stocks based on intraday performance
 *
 * No static getInstance() — instantiated by the container.
 */
export class AutoTradingService {
  private scanTimer: NodeJS.Timeout | null = null;
  private rotationTimer: NodeJS.Timeout | null = null;
  private lastPicks: string[] = [];

  // Market Pre-Open is at 9:00 AM IST. Normal trading starts at 9:15 AM IST.
  private readonly SCAN_HOUR_IST = 9;
  private readonly SCAN_MINUTE_IST = 0;

  // Rotation every 60 minutes during market hours
  private readonly ROTATION_INTERVAL_MS = 60 * 60 * 1000;

  constructor(
    private readonly scanner: MarketScannerService,
    private readonly tickerClient: TickerClient | null,
    private readonly stopLossMonitor: StopLossMonitor,
    private readonly portfolioService: PortfolioService,
    private readonly userRepository: UserRepo,
    private readonly tradingLoop: TradingLoopService
  ) { }

  /**
   * Start the auto-trading scheduler
   */
  public start(): void {
    if (this.scanTimer) return;

    const now = new Date();
    const isMarketHours = this.isMarketHours(now);

    if (isMarketHours) {
      logger.info("Service started during market hours. Running initial scan immediately.");
      void this.executeDailyRoutine();
      this.startRotationTimer();
    }

    this.scheduleNextScan();
  }

  /**
   * Start the periodic rotation timer
   */
  private startRotationTimer(): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
    }

    logger.info({ intervalMinutes: this.ROTATION_INTERVAL_MS / 60000 }, "Intraday rotation timer started");

    this.rotationTimer = setInterval(async () => {
      if (this.isMarketHours(new Date())) {
        await this.executeRotationRoutine();
      } else {
        logger.info("Outside market hours, skipping rotation");
        this.stopRotationTimer();
      }
    }, this.ROTATION_INTERVAL_MS);
  }

  private stopRotationTimer(): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
      logger.info("Intraday rotation timer stopped");
    }
  }

  /**
   * Schedule the next scan for 9:00 AM IST
   */
  private scheduleNextScan(): void {
    const delay = this.calculateNextScanDelay();

    logger.info(
      { nextScanAt: new Date(Date.now() + delay).toISOString() },
      "Next market scan scheduled"
    );

    this.scanTimer = setTimeout(async () => {
      await this.executeDailyRoutine();
      this.startRotationTimer();
      this.scheduleNextScan();
    }, delay);
  }

  /**
   * Main daily routine: Scan -> Apply -> Trade
   */
  public async executeDailyRoutine(): Promise<void> {
    try {
      logger.info("Executing daily auto-trading routine...");

      const picks = await this.scanner.scan(10);

      if (picks.length === 0) {
        logger.warn("No stocks met the criteria today.");
        return;
      }

      this.lastPicks = picks.map(p => p.symbol);

      if (this.tickerClient) {
        await this.scanner.applyPicks(picks, this.tickerClient);
      } else {
        logger.warn("Ticker client not available. Cannot subscribe to picks.");
      }

      // Start Trading Loop (via injected instance, not static)
      if (!this.tradingLoop.getStatus().running) {
        this.tradingLoop.start();
        logger.info("Trading loop started automatically");
      }

      if (!this.stopLossMonitor.isRunning()) {
        this.stopLossMonitor.start();
        logger.info("Stop-loss monitor started automatically");
      }

      logger.info("Daily auto-trading routine completed successfully");
    } catch (error) {
      logger.error({ err: error }, "Failed to execute daily auto-trading routine");
    }
  }

  /**
   * Rotation routine: Re-scan -> Update picks -> Unsubscribe dead money
   */
  public async executeRotationRoutine(): Promise<void> {
    try {
      logger.info("Executing intraday rotation routine...");

      const newPicksResult = await this.scanner.scan(10);
      const newPickSymbols = newPicksResult.map(p => p.symbol);

      if (newPickSymbols.length === 0) {
        logger.warn("Rotation scan found no suitable stocks. Maintaining current picks.");
        return;
      }

      // Identify active positions across ALL users
      const users = this.userRepository.listUsers();
      const activePositionSymbols = new Set<string>();

      for (const user of users) {
        const snapshot = await this.portfolioService.getSnapshot(user.id);
        snapshot.positions.forEach(p => {
          if (p.netQuantity !== 0) {
            activePositionSymbols.add(p.symbol);
          }
        });
      }

      // Identify symbols to unsubscribe (Dead Money)
      const toUnsubscribe = this.lastPicks.filter(
        symbol => !newPickSymbols.includes(symbol) && !activePositionSymbols.has(symbol)
      );

      if (this.tickerClient) {
        for (const symbol of toUnsubscribe) {
          const token = this.scanner.instrumentService.getToken(symbol, "NSE");
          if (token) {
            this.tickerClient.unsubscribe("NSE", token);
            logger.info({ symbol }, "Unsubscribed from dead money stock during rotation");
          }
        }

        await this.scanner.applyPicks(newPicksResult, this.tickerClient);
      }

      this.lastPicks = [...new Set([...newPickSymbols, ...activePositionSymbols])];

      logger.info(
        {
          newPicks: newPickSymbols,
          unsubscribed: toUnsubscribe,
          totalWatched: this.lastPicks.length
        },
        "Intraday rotation completed"
      );
    } catch (error) {
      logger.error({ err: error }, "Failed to execute intraday rotation routine");
    }
  }

  isMarketHours(date: Date): boolean {
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(date.getTime() + istOffset);
    const day = istDate.getUTCDay();
    const hours = istDate.getUTCHours();
    const minutes = istDate.getUTCMinutes();

    if (day === 0 || day === 6) return false;

    const timeInMinutes = hours * 60 + minutes;
    const marketOpen = 9 * 60 + 15;
    const marketClose = 15 * 60 + 30;

    return timeInMinutes >= marketOpen && timeInMinutes <= marketClose;
  }

  private calculateNextScanDelay(): number {
    const now = new Date();
    const IST_OFFSET_MINUTES = 330;
    const scanMinutesIst = this.SCAN_HOUR_IST * 60 + this.SCAN_MINUTE_IST;
    const scanMinutesUtc = (scanMinutesIst - IST_OFFSET_MINUTES + 24 * 60) % (24 * 60);

    const target = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        Math.floor(scanMinutesUtc / 60),
        scanMinutesUtc % 60,
        0,
        0
      )
    );

    if (target <= now) {
      target.setUTCDate(target.getUTCDate() + 1);
    }

    return target.getTime() - now.getTime();
  }

  public stop(): void {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    this.stopRotationTimer();
  }
}

export default AutoTradingService;
