import { loadToken, type ZerodhaTokenData } from "../routes/auth";
import logger from "../utils/logger";
import env from "../config/env";

/**
 * Service to manage Zerodha authentication state
 */
export class AuthService {
  private static instance: AuthService;
  private tokenData: ZerodhaTokenData | null = null;

  private constructor() {}

  public static getInstance(): AuthService {
    if (!AuthService.instance) {
      AuthService.instance = new AuthService();
    }
    return AuthService.instance;
  }

  /**
   * Initialize auth service and load saved tokens
   */
  public async initialize(): Promise<void> {
    if (env.brokerProvider !== "zerodha") {
      logger.info("Zerodha broker not enabled, skipping token load");
      return;
    }

    try {
      const tokenData = await loadToken();

      if (tokenData) {
        // Inject token into environment for broker to use
        process.env.ZERODHA_ACCESS_TOKEN = tokenData.accessToken;
        this.tokenData = tokenData;

        logger.info(
          {
            userId: tokenData.userId,
            expiresAt: tokenData.expiresAt,
          },
          "Zerodha access token loaded from storage"
        );
      } else {
        logger.info("No saved Zerodha token found, authentication required");
      }
    } catch (error) {
      logger.error({ err: error }, "Failed to load saved Zerodha token");
    }
  }

  /**
   * Get current token data
   */
  public getTokenData(): ZerodhaTokenData | null {
    return this.tokenData;
  }

  /**
   * Check if token is valid and not expired
   */
  public isAuthenticated(): boolean {
    if (!this.tokenData) {
      return false;
    }

    const expiresAt = new Date(this.tokenData.expiresAt);
    return expiresAt > new Date();
  }

  /**
   * Clear authentication state
   */
  public clear(): void {
    this.tokenData = null;
    delete process.env.ZERODHA_ACCESS_TOKEN;
  }
}

export default AuthService;
