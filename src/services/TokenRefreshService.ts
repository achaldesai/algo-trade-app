import { SmartAPI } from "smartapi-javascript";
import { authenticator } from "otplib";
import logger from "../utils/logger";
import env from "../config/env";
import { loadAngelToken, saveAngelToken } from "../routes/auth";
import type { AngelOneTokenData } from "../persistence/TokenRepository";

/**
 * Service to manage automatic token refresh for Angel One
 *
 * Features:
 * - Automatic daily re-authentication at 4:30 AM IST (before 5 AM token expiry)
 * - Mid-session token refresh on demand
 * - TOTP-based authentication (no manual intervention required)
 */
export class TokenRefreshService {
  private static instance: TokenRefreshService;
  private refreshTimer: NodeJS.Timeout | null = null;
  private smartApi: SmartAPI | null = null;

  // Angel One tokens expire at 5 AM IST (23:30 UTC previous day)
  // We'll refresh at 4:30 AM IST (23:00 UTC previous day) to be safe
  private readonly REFRESH_HOUR_IST = 4;
  private readonly REFRESH_MINUTE_IST = 30;

  private constructor() {
    if (env.angelOneApiKey) {
      this.smartApi = new SmartAPI({ api_key: env.angelOneApiKey });
    }
  }

  public static getInstance(): TokenRefreshService {
    if (!TokenRefreshService.instance) {
      TokenRefreshService.instance = new TokenRefreshService();
    }
    return TokenRefreshService.instance;
  }

  /**
   * Calculate milliseconds until next refresh time (4:30 AM IST)
   */
  private calculateNextRefreshDelay(): number {
    const now = new Date();

    // Convert IST to UTC: IST is UTC+5:30
    // 4:30 AM IST = 11:00 PM UTC previous day
    const targetHourUTC = this.REFRESH_HOUR_IST - 5; // 4 - 5 = -1 (previous day 23:00)
    const targetMinuteUTC = this.REFRESH_MINUTE_IST - 30; // 30 - 30 = 0

    let target = new Date(now);
    target.setUTCHours(targetHourUTC < 0 ? 24 + targetHourUTC : targetHourUTC);
    target.setUTCMinutes(targetMinuteUTC < 0 ? 60 + targetMinuteUTC : targetMinuteUTC);
    target.setUTCSeconds(0);
    target.setUTCMilliseconds(0);

    // If target time has passed today, schedule for tomorrow
    if (target <= now) {
      target.setUTCDate(target.getUTCDate() + 1);
    }

    const delay = target.getTime() - now.getTime();

    logger.debug(
      {
        nextRefreshAt: target.toISOString(),
        delayMs: delay,
        delayHours: (delay / (1000 * 60 * 60)).toFixed(2),
      },
      "Calculated next token refresh time"
    );

    return delay;
  }

  /**
   * Perform full re-authentication with TOTP
   */
  private async performReauthentication(): Promise<void> {
    if (!env.angelOneApiKey || !env.angelOneClientId || !env.angelOnePassword) {
      throw new Error("Angel One credentials not configured");
    }

    if (!env.angelOneTotpSecret) {
      throw new Error("Angel One TOTP secret not configured. Cannot perform automatic re-authentication.");
    }

    if (!this.smartApi) {
      this.smartApi = new SmartAPI({ api_key: env.angelOneApiKey });
    }

    // Generate TOTP
    const totp = authenticator.generate(env.angelOneTotpSecret);

    logger.info({ clientId: env.angelOneClientId }, "Performing automatic Angel One re-authentication");

    // Generate new session
    const response = await this.smartApi.generateSession(
      env.angelOneClientId,
      env.angelOnePassword,
      totp
    );

    if (!response.status || !response.data) {
      throw new Error(response.message || "Re-authentication failed");
    }

    // Calculate new expiry (24 hours from now)
    const now = new Date();
    const expiryDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // Save new tokens
    const tokenData: AngelOneTokenData = {
      jwtToken: response.data.jwtToken,
      refreshToken: response.data.refreshToken,
      feedToken: response.data.feedToken,
      clientId: env.angelOneClientId,
      expiresAt: expiryDate.toISOString(),
    };

    await saveAngelToken(tokenData);

    logger.info(
      {
        clientId: env.angelOneClientId,
        expiresAt: expiryDate.toISOString(),
      },
      "Angel One automatic re-authentication successful"
    );
  }

  /**
   * Perform token refresh using existing refresh token
   * (useful for mid-session reconnections)
   */
  public async refreshToken(): Promise<void> {
    const tokenData = await loadAngelToken();

    if (!tokenData) {
      logger.warn("No Angel One token found to refresh");
      return;
    }

    // Check if token is expired - need full re-authentication
    const expiresAt = new Date(tokenData.expiresAt);
    if (expiresAt < new Date()) {
      logger.info("Token expired, performing full re-authentication");
      await this.performReauthentication();
      return;
    }

    if (!this.smartApi) {
      throw new Error("SmartAPI not initialized");
    }

    logger.info({ clientId: tokenData.clientId }, "Refreshing Angel One token");

    const response = await this.smartApi.generateToken(tokenData.refreshToken);

    if (!response.status || !response.data) {
      throw new Error(response.message || "Token refresh failed");
    }

    // Update tokens (same expiry)
    const updatedTokenData: AngelOneTokenData = {
      jwtToken: response.data.jwtToken,
      refreshToken: response.data.refreshToken,
      feedToken: response.data.feedToken,
      clientId: tokenData.clientId,
      expiresAt: tokenData.expiresAt,
    };

    await saveAngelToken(updatedTokenData);

    logger.info({ clientId: tokenData.clientId }, "Angel One token refreshed successfully");
  }

  /**
   * Start the automatic refresh scheduler
   */
  public start(): void {
    if (env.brokerProvider !== "angelone") {
      logger.debug("Angel One broker not enabled, skipping token refresh scheduler");
      return;
    }

    if (!env.angelOneTotpSecret) {
      logger.warn(
        "Angel One TOTP secret not configured. Automatic token refresh disabled. " +
        "Set ANGEL_ONE_TOTP_SECRET in .env to enable automatic re-authentication."
      );
      return;
    }

    // Stop existing timer if any
    this.stop();

    const scheduleNext = () => {
      const delay = this.calculateNextRefreshDelay();

      this.refreshTimer = setTimeout(async () => {
        try {
          await this.performReauthentication();
        } catch (error) {
          logger.error({ err: error }, "Automatic token re-authentication failed");
        }

        // Schedule next refresh
        scheduleNext();
      }, delay);

      logger.info(
        {
          nextRefreshAt: new Date(Date.now() + delay).toISOString(),
        },
        "Angel One automatic token refresh scheduled"
      );
    };

    scheduleNext();
  }

  /**
   * Stop the automatic refresh scheduler
   */
  public stop(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
      logger.info("Angel One token refresh scheduler stopped");
    }
  }

  /**
   * Check if scheduler is running
   */
  public isRunning(): boolean {
    return this.refreshTimer !== null;
  }
}

export default TokenRefreshService;
