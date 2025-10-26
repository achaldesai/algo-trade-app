import { Router, type Request, type Response } from "express";
import { KiteConnect } from "kiteconnect";
import { SmartAPI } from "smartapi-javascript";
import { authenticator } from "otplib";
import env from "../config/env";
import logger from "../utils/logger";
import { HttpError } from "../utils/HttpError";
import { getTokenRepository } from "../persistence/TokenRepository";
import type { ZerodhaTokenData, AngelOneTokenData } from "../persistence/TokenRepository";

const router = Router();

/**
 * Save Zerodha access token to LMDB
 */
async function saveToken(tokenData: ZerodhaTokenData): Promise<void> {
  try {
    const tokenRepo = getTokenRepository(env.portfolioStorePath);
    await tokenRepo.saveZerodhaToken(tokenData);
  } catch (error) {
    logger.error({ err: error }, "Failed to save Zerodha token");
    throw error;
  }
}

/**
 * Load Zerodha access token from LMDB
 */
async function loadToken(): Promise<ZerodhaTokenData | null> {
  try {
    const tokenRepo = getTokenRepository(env.portfolioStorePath);
    return await tokenRepo.getZerodhaToken();
  } catch (error) {
    logger.error({ err: error }, "Failed to load Zerodha token");
    return null;
  }
}

/**
 * GET /auth/zerodha/login
 * Redirect user to Zerodha login page
 */
router.get("/zerodha/login", (req: Request, res: Response) => {
  try {
    if (!env.brokerApiKey) {
      throw new HttpError(400, "Zerodha API key not configured");
    }

    const kite = new KiteConnect({ api_key: env.brokerApiKey });
    const loginUrl = kite.getLoginURL();

    logger.info("Redirecting to Zerodha login");

    res.json({
      loginUrl,
      message: "Open this URL in your browser to login to Zerodha",
      instructions: [
        "1. Open the loginUrl in your browser",
        "2. Login with your Zerodha credentials",
        "3. After successful login, you'll be redirected with a request_token",
        "4. Copy the request_token and call POST /api/auth/zerodha/callback with it",
      ],
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;

    logger.error({ err: error }, "Failed to generate Zerodha login URL");
    throw new HttpError(500, "Failed to generate login URL");
  }
});

/**
 * POST /auth/zerodha/callback
 * Exchange request token for access token
 * Body: { requestToken: string }
 */
router.post("/zerodha/callback", async (req: Request, res: Response) => {
  try {
    const { requestToken } = req.body as { requestToken?: string };

    if (!requestToken) {
      throw new HttpError(400, "Request token is required");
    }

    if (!env.brokerApiKey || !env.brokerApiSecret) {
      throw new HttpError(400, "Zerodha API credentials not configured");
    }

    const kite = new KiteConnect({
      api_key: env.brokerApiKey,
    });

    logger.info("Exchanging request token for access token");

    // Generate session (exchange request token for access token)
    const session = await kite.generateSession(requestToken, env.brokerApiSecret);

    // Calculate expiry (Zerodha tokens expire at 6 AM IST next day)
    const now = new Date();
    const expiryDate = new Date(now);
    expiryDate.setUTCHours(0, 30, 0, 0); // 6 AM IST = 00:30 UTC
    if (expiryDate <= now) {
      expiryDate.setDate(expiryDate.getDate() + 1);
    }

    // Save token to persistent storage
    const tokenData: ZerodhaTokenData = {
      accessToken: session.access_token,
      expiresAt: expiryDate.toISOString(),
      userId: session.user_id,
      apiKey: env.brokerApiKey,
    };

    await saveToken(tokenData);

    // Update environment variable for current session
    process.env.ZERODHA_ACCESS_TOKEN = session.access_token;

    logger.info(
      {
        userId: session.user_id,
        expiresAt: expiryDate.toISOString(),
      },
      "Zerodha authentication successful"
    );

    res.json({
      success: true,
      message: "Authentication successful",
      data: {
        userId: session.user_id,
        userName: session.user_name,
        email: session.email,
        expiresAt: expiryDate.toISOString(),
        broker: session.broker,
      },
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;

    logger.error({ err: error }, "Failed to exchange request token");

    // Provide more helpful error messages
    const errorMessage =
      error instanceof Error && error.message.includes("Invalid")
        ? "Invalid or expired request token"
        : "Failed to complete authentication";

    throw new HttpError(400, errorMessage);
  }
});

/**
 * GET /auth/zerodha/status
 * Check authentication status
 */
router.get("/zerodha/status", async (req: Request, res: Response) => {
  try {
    const tokenData = await loadToken();

    if (!tokenData) {
      res.json({
        authenticated: false,
        message: "No active Zerodha session",
      });
      return;
    }

    // Check if current access token matches saved one
    const currentToken = env.brokerAccessToken || process.env.ZERODHA_ACCESS_TOKEN;
    const isActive = currentToken === tokenData.accessToken;

    res.json({
      authenticated: true,
      isActive,
      userId: tokenData.userId,
      expiresAt: tokenData.expiresAt,
      message: isActive ? "Zerodha session is active" : "Token found but not currently active",
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to check auth status");
    throw new HttpError(500, "Failed to check authentication status");
  }
});

/**
 * POST /auth/zerodha/logout
 * Clear stored access token
 */
router.post("/zerodha/logout", async (req: Request, res: Response) => {
  try {
    const tokenRepo = getTokenRepository(env.portfolioStorePath);
    await tokenRepo.deleteZerodhaToken();

    // Clear environment variable
    delete process.env.ZERODHA_ACCESS_TOKEN;

    logger.info("Zerodha session terminated");

    res.json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to logout");
    throw new HttpError(500, "Failed to logout");
  }
});

/**
 * GET /auth/zerodha/token
 * Get current access token (for debugging/manual use)
 */
router.get("/zerodha/token", async (req: Request, res: Response) => {
  try {
    const tokenData = await loadToken();

    if (!tokenData) {
      throw new HttpError(404, "No access token found");
    }

    res.json({
      accessToken: tokenData.accessToken,
      expiresAt: tokenData.expiresAt,
      userId: tokenData.userId,
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;

    logger.error({ err: error }, "Failed to retrieve token");
    throw new HttpError(500, "Failed to retrieve access token");
  }
});

// ============================================================================
// Angel One SmartAPI Authentication Routes
// ============================================================================

/**
 * Save Angel One token to LMDB
 */
async function saveAngelToken(tokenData: AngelOneTokenData): Promise<void> {
  try {
    const tokenRepo = getTokenRepository(env.portfolioStorePath);
    await tokenRepo.saveAngelOneToken(tokenData);
  } catch (error) {
    logger.error({ err: error }, "Failed to save Angel One token");
    throw error;
  }
}

/**
 * Load Angel One token from LMDB
 */
async function loadAngelToken(): Promise<AngelOneTokenData | null> {
  try {
    const tokenRepo = getTokenRepository(env.portfolioStorePath);
    return await tokenRepo.getAngelOneToken();
  } catch (error) {
    logger.error({ err: error }, "Failed to load Angel One token");
    return null;
  }
}

/**
 * POST /auth/angelone/login
 * Authenticate with Angel One SmartAPI
 * Body: { totp?: string }
 */
router.post("/angelone/login", async (req: Request, res: Response) => {
  try {
    const { totp } = req.body as { totp?: string };

    if (!env.angelOneApiKey || !env.angelOneClientId || !env.angelOnePassword) {
      throw new HttpError(400, "Angel One credentials not configured");
    }

    const smartApi = new SmartAPI({ api_key: env.angelOneApiKey });

    logger.info("Authenticating with Angel One SmartAPI");

    // Generate TOTP if secret is set, otherwise use provided TOTP
    let totpValue = totp;
    if (!totpValue && env.angelOneTotpSecret) {
      try {
        totpValue = authenticator.generate(env.angelOneTotpSecret);
        logger.debug("TOTP generated from secret");
      } catch (error) {
        logger.error({ err: error }, "Failed to generate TOTP from secret");
        throw new HttpError(500, "Failed to generate TOTP code");
      }
    }

    if (!totpValue) {
      throw new HttpError(400, "TOTP is required. Either provide it in the request body or set ANGEL_ONE_TOTP_SECRET in .env");
    }

    // Generate session
    const response = await smartApi.generateSession(
      env.angelOneClientId,
      env.angelOnePassword,
      totpValue
    );

    if (!response.status || !response.data) {
      throw new HttpError(400, response.message || "Authentication failed");
    }

    // Calculate expiry (Angel One tokens typically expire in 1 day)
    const now = new Date();
    const expiryDate = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours

    // Save token to persistent storage
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
      "Angel One authentication successful"
    );

    res.json({
      success: true,
      message: "Authentication successful",
      data: {
        clientId: env.angelOneClientId,
        expiresAt: expiryDate.toISOString(),
        jwtToken: response.data.jwtToken,
        feedToken: response.data.feedToken,
      },
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;

    logger.error({ err: error }, "Failed to authenticate with Angel One");

    const errorMessage =
      error instanceof Error && error.message.includes("Invalid")
        ? "Invalid credentials or TOTP"
        : "Failed to complete authentication";

    throw new HttpError(400, errorMessage);
  }
});

/**
 * GET /auth/angelone/status
 * Check Angel One authentication status
 */
router.get("/angelone/status", async (req: Request, res: Response) => {
  try {
    const tokenData = await loadAngelToken();

    if (!tokenData) {
      res.json({
        authenticated: false,
        message: "No active Angel One session",
      });
      return;
    }

    res.json({
      authenticated: true,
      clientId: tokenData.clientId,
      expiresAt: tokenData.expiresAt,
      message: "Angel One session is active",
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to check Angel One auth status");
    throw new HttpError(500, "Failed to check authentication status");
  }
});

/**
 * POST /auth/angelone/logout
 * Clear stored Angel One token
 */
router.post("/angelone/logout", async (req: Request, res: Response) => {
  try {
    const tokenRepo = getTokenRepository(env.portfolioStorePath);
    await tokenRepo.deleteAngelOneToken();

    logger.info("Angel One session terminated");

    res.json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to logout from Angel One");
    throw new HttpError(500, "Failed to logout");
  }
});

/**
 * POST /auth/angelone/refresh
 * Refresh Angel One JWT token using refresh token
 *
 * Note: Refreshed tokens maintain the same expiry time as the original token.
 * This is useful for recovering from mid-session disconnections but won't extend the session.
 * For a fresh session after expiry, use POST /api/auth/angelone/login
 */
router.post("/angelone/refresh", async (req: Request, res: Response) => {
  try {
    const tokenData = await loadAngelToken();

    if (!tokenData) {
      throw new HttpError(404, "No Angel One session found");
    }

    if (!env.angelOneApiKey) {
      throw new HttpError(400, "Angel One API key not configured");
    }

    // Check if token is already expired
    const expiresAt = new Date(tokenData.expiresAt);
    if (expiresAt < new Date()) {
      throw new HttpError(401, "Token has expired. Please re-authenticate using POST /api/auth/angelone/login");
    }

    const smartApi = new SmartAPI({ api_key: env.angelOneApiKey });

    logger.info({ clientId: tokenData.clientId }, "Refreshing Angel One token");

    // Use refresh token to generate new tokens
    const response = await smartApi.generateToken(tokenData.refreshToken);

    if (!response.status || !response.data) {
      throw new HttpError(400, response.message || "Token refresh failed");
    }

    // Update token data with new tokens (keeping same expiry)
    const updatedTokenData: AngelOneTokenData = {
      jwtToken: response.data.jwtToken,
      refreshToken: response.data.refreshToken,
      feedToken: response.data.feedToken,
      clientId: tokenData.clientId,
      expiresAt: tokenData.expiresAt, // Same expiry as original
    };

    await saveAngelToken(updatedTokenData);

    logger.info(
      {
        clientId: tokenData.clientId,
        expiresAt: tokenData.expiresAt,
      },
      "Angel One token refreshed successfully"
    );

    res.json({
      success: true,
      message: "Token refreshed successfully",
      data: {
        clientId: tokenData.clientId,
        expiresAt: tokenData.expiresAt,
        jwtToken: response.data.jwtToken,
        feedToken: response.data.feedToken,
      },
      note: "Refreshed token maintains the same expiry time as the original token",
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;

    logger.error({ err: error }, "Failed to refresh Angel One token");

    const errorMessage =
      error instanceof Error && error.message.includes("Invalid")
        ? "Invalid or expired refresh token"
        : "Failed to refresh token";

    throw new HttpError(400, errorMessage);
  }
});

export default router;

// Export helper functions for use in other services
export { loadToken, saveToken, loadAngelToken, saveAngelToken };
export type { ZerodhaTokenData, AngelOneTokenData };
