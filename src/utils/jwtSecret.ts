import env from "../config/env";
import { HttpError } from "./HttpError";
import logger from "./logger";

const DEV_FALLBACK_SECRET = "fallback-secret-for-dev";

/**
 * Single source of truth for the secret that signs and verifies user JWTs.
 * Used by login (sign), userAuth and adminAuth (verify) — they must agree,
 * so never resolve the secret anywhere else.
 */
export function getJwtSecret(): string {
  if (env.adminApiKey) return env.adminApiKey;

  if (env.nodeEnv === "production") {
    throw new HttpError(
      503,
      "Authentication is not configured. Set ADMIN_API_KEY in environment variables."
    );
  }

  logger.warn("ADMIN_API_KEY is not set — using fallback secret for DEVELOPMENT only. DO NOT use in production.");
  return DEV_FALLBACK_SECRET;
}
