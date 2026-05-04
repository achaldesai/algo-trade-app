import { Router, type Request, type Response } from "express";
import { KiteConnect } from "kiteconnect";
import { SmartAPI } from "smartapi-javascript";
import { authenticator } from "otplib";
import env from "../config/env";
import logger from "../utils/logger";
import { HttpError } from "../utils/HttpError";
import type { ZerodhaTokenData, AngelOneTokenData } from "../types/tokens";
import { userAuthMiddleware } from "../middleware/userAuth";
import { getContainer } from "../util/getContainer";

const router = Router();

function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return token.slice(0, 4) + "****" + token.slice(-4);
}

/**
 * GET /auth/zerodha/login
 * Redirect user to Zerodha login page
 */
router.get("/zerodha/login", userAuthMiddleware, (req: Request, res: Response) => {
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
 * GET /auth/zerodha/callback
 * Automatic redirect handler from Zerodha
 * Query: ?request_token=...&status=success
 */
router.get("/zerodha/callback", userAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { request_token: requestToken } = req.query as { request_token?: string };

    if (!requestToken) {
      throw new HttpError(400, "Request token is missing from redirect");
    }

    if (!env.brokerApiKey || !env.brokerApiSecret) {
      throw new HttpError(400, "Zerodha API credentials not configured");
    }

    const kite = new KiteConnect({
      api_key: env.brokerApiKey,
    });

    logger.info("Automatically exchanging request token from redirect");

    const session = await kite.generateSession(requestToken, env.brokerApiSecret);

    const now = new Date();
    const expiryDate = new Date(now);
    expiryDate.setUTCHours(0, 30, 0, 0);
    if (expiryDate <= now) {
      expiryDate.setDate(expiryDate.getDate() + 1);
    }

    const tokenData: ZerodhaTokenData = {
      accessToken: session.access_token,
      expiresAt: expiryDate.toISOString(),
      userId: session.user_id, // Zerodha's external user ID, keeping it in data
      apiKey: env.brokerApiKey,
    };

    await getContainer(req).tokenRepo.saveZerodhaToken(userId, tokenData);
    // process.env.ZERODHA_ACCESS_TOKEN = session.access_token; // Removed global mutation

    logger.info({ userId, zerodhaUserId: session.user_id }, "Zerodha automatic authentication successful");

    res.redirect("/");
  } catch (error) {
    logger.error({ err: error }, "Failed to handle Zerodha redirect");
    res.status(400).send(`Authentication failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
});

/**
 * POST /auth/zerodha/callback
 * Exchange request token for access token
 * Body: { requestToken: string }
 */
router.post("/zerodha/callback", userAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
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

    logger.info("Exchanging request token for access token");

    const session = await kite.generateSession(requestToken, env.brokerApiSecret);

    // Calculate expiry (Zerodha tokens expire at 6 AM IST next day)
    const now = new Date();
    const expiryDate = new Date(now);
    expiryDate.setUTCHours(0, 30, 0, 0); // 6 AM IST = 00:30 UTC
    if (expiryDate <= now) {
      expiryDate.setDate(expiryDate.getDate() + 1);
    }

    const tokenData: ZerodhaTokenData = {
      accessToken: session.access_token,
      expiresAt: expiryDate.toISOString(),
      userId: session.user_id,
      apiKey: env.brokerApiKey,
    };

    await getContainer(req).tokenRepo.saveZerodhaToken(userId, tokenData);

    logger.info(
      {
        userId,
        zerodhaUserId: session.user_id,
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
 * Falls back to SYSTEM_DEFAULT token since the broker client uses it globally
 */
router.get("/zerodha/status", userAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const container = getContainer(req);
    const userId = req.user!.userId;
    let tokenData = container.tokenRepo.getZerodhaToken(userId);

    if (!tokenData) {
      tokenData = container.tokenRepo.getZerodhaToken("SYSTEM_DEFAULT");
    }

    if (!tokenData) {
      res.json({
        authenticated: false,
        message: "No active Zerodha session",
      });
      return;
    }

    res.json({
      authenticated: true,
      isActive: true,
      zerodhaUserId: tokenData.userId,
      expiresAt: tokenData.expiresAt,
      message: "Zerodha session is active",
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
router.post("/zerodha/logout", userAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    await getContainer(req).tokenRepo.deleteZerodhaToken(userId);

    logger.info({ userId }, "Zerodha session terminated");

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
router.get("/zerodha/token", userAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const tokenData = getContainer(req).tokenRepo.getZerodhaToken(userId);

    if (!tokenData) {
      throw new HttpError(404, "No access token found");
    }

    res.json({
      accessToken: maskToken(tokenData.accessToken),
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
 * POST /auth/angelone/login
 * Authenticate with Angel One SmartAPI
 * Body: { totp?: string }
 */
router.post("/angelone/login", userAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
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

    const { jwtToken, refreshToken, feedToken } = response.data;

    if (!jwtToken || !refreshToken || !feedToken) {
      throw new HttpError(502, "Angel One session response missing required tokens");
    }

    // Save token to persistent storage
    const tokenData: AngelOneTokenData = {
      jwtToken,
      refreshToken,
      feedToken,
      clientId: env.angelOneClientId,
      expiresAt: expiryDate.toISOString(),
    };

    await getContainer(req).tokenRepo.saveAngelOneToken(userId, tokenData);

    logger.info(
      {
        userId,
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
        jwtToken: maskToken(jwtToken),
        feedToken: maskToken(feedToken),
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
 * Falls back to SYSTEM_DEFAULT token since the ticker service uses it globally
 */
router.get("/angelone/status", userAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const container = getContainer(req);
    const userId = req.user!.userId;
    let tokenData = container.tokenRepo.getAngelOneToken(userId);

    if (!tokenData) {
      tokenData = container.tokenRepo.getAngelOneToken("SYSTEM_DEFAULT");
    }

    if (!tokenData) {
      res.json({
        authenticated: false,
        message: "No active Angel One session",
      });
      return;
    }

    const tickerConnected = container.tickerClient?.isConnected() ?? false;

    res.json({
      authenticated: true,
      tickerConnected,
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
router.post("/angelone/logout", userAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    await getContainer(req).tokenRepo.deleteAngelOneToken(userId);

    logger.info({ userId }, "Angel One session terminated");

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
router.post("/angelone/refresh", userAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const tokenData = getContainer(req).tokenRepo.getAngelOneToken(userId);

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

    const { jwtToken, refreshToken, feedToken } = response.data;

    if (!jwtToken || !refreshToken || !feedToken) {
      throw new HttpError(502, "Angel One refresh response missing required tokens");
    }

    // Update token data with new tokens (keeping same expiry)
    const updatedTokenData: AngelOneTokenData = {
      jwtToken,
      refreshToken,
      feedToken,
      clientId: tokenData.clientId,
      expiresAt: tokenData.expiresAt, // Same expiry as original
    };

    await getContainer(req).tokenRepo.saveAngelOneToken(userId, updatedTokenData);

    logger.info(
      {
        userId,
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
        jwtToken: maskToken(jwtToken),
        feedToken: maskToken(feedToken),
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

export type { ZerodhaTokenData, AngelOneTokenData };
