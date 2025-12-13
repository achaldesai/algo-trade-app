import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { HttpError } from "../utils/HttpError";
import env from "../config/env";
import logger from "../utils/logger";

/**
 * Middleware to protect admin endpoints with API key authentication
 *
 * Usage:
 * - Set ADMIN_API_KEY in environment variables
 * - Include "X-Admin-API-Key" header in requests to admin endpoints
 */
export function adminAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const adminApiKey = env.adminApiKey;

  // If no admin API key is configured, deny all admin access
  if (!adminApiKey) {
    logger.warn(
      { path: req.path },
      "Admin endpoint accessed but ADMIN_API_KEY not configured. Denying access."
    );
    throw new HttpError(
      503,
      "Admin endpoints are not configured. Set ADMIN_API_KEY in environment variables."
    );
  }

  // Check for API key in header
  const headerVal = req.headers["x-admin-api-key"];
  const providedKey = Array.isArray(headerVal) ? headerVal[0] : headerVal;

  if (!providedKey) {
    logger.warn({ path: req.path, ip: req.ip }, "Admin endpoint accessed without API key");
    throw new HttpError(401, "Admin API key required. Include X-Admin-API-Key header.");
  }

  // Validate API key using SHA-256 hash comparison to prevent timing attacks
  const hash = (str: string) => crypto.createHash('sha256').update(str).digest();

  const providedHash = hash(providedKey);
  const adminHash = hash(adminApiKey);

  if (!crypto.timingSafeEqual(providedHash, adminHash)) {
    logger.warn(
      { path: req.path, ip: req.ip },
      "Admin endpoint accessed with invalid API key"
    );
    throw new HttpError(403, "Invalid admin API key");
  }

  // Authentication successful
  logger.debug({ path: req.path }, "Admin authentication successful");
  next();
}
