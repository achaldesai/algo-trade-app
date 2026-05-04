import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { HttpError } from "../utils/HttpError";
import env from "../config/env";
import logger from "../utils/logger";
import { getContainer } from "../util/getContainer";

export interface TokenPayload {
  userId: string;
  role: string;
}

function getJwtSecret(): string {
  if (env.adminApiKey) return env.adminApiKey;

  if (env.nodeEnv === "production") {
    throw new HttpError(
      503,
      "Admin endpoints are not configured. Set ADMIN_API_KEY in environment variables."
    );
  }

  logger.warn("ADMIN_API_KEY is not set — using fallback secret for DEVELOPMENT only. DO NOT use in production.");
  return "fallback-secret-for-dev";
}

/**
 * Middleware to protect admin endpoints with API key authentication or Admin JWT
 */
export async function adminAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {

  // First try JWT authentication if Authorization header is present
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    try {
      const secret = getJwtSecret();
      const decoded = jwt.verify(token, secret) as TokenPayload;

      if (decoded.role === "ADMIN") {
        const repo = getContainer(req).userRepo;
        const user = repo.findUserById(decoded.userId);

        if (user) {
          req.user = decoded; // Attach user payload
          return next();
        }
      }
    } catch (_err) {
      logger.warn({ path: req.path, ip: req.ip }, "Failed admin JWT verification");
      // Fallthrough to check API key
    }
  }

  // Fallback to traditional X-Admin-API-Key check
  const adminApiKey = env.adminApiKey;

  if (!adminApiKey) {
    logger.warn(
      { path: req.path },
      "Admin endpoint accessed but ADMIN_API_KEY not configured. Denying access."
    );
    return next(new HttpError(
      503,
      "Admin endpoints are not configured. Set ADMIN_API_KEY in environment variables."
    ));
  }

  const headerVal = req.headers["x-admin-api-key"];
  const providedKey = Array.isArray(headerVal) ? headerVal[0] : headerVal;

  if (!providedKey) {
    logger.warn({ path: req.path, ip: req.ip }, "Admin endpoint accessed without API key or valid JWT");
    return next(new HttpError(401, "Admin credentials required (Valid JWT or X-Admin-API-Key header)."));
  }

  const hash = (str: string) => crypto.createHash('sha256').update(str).digest();

  const providedHash = hash(providedKey);
  const adminHash = hash(adminApiKey);

  if (!crypto.timingSafeEqual(providedHash, adminHash)) {
    logger.warn(
      { path: req.path, ip: req.ip },
      "Admin endpoint accessed with invalid API key"
    );
    return next(new HttpError(403, "Invalid admin API key"));
  }

  logger.debug({ path: req.path }, "Admin API key authentication successful");
  next();
}
