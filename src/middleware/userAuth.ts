import type { Request, Response, NextFunction } from "express";
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
            "Authentication is not configured. Set ADMIN_API_KEY in environment variables."
        );
    }

    logger.warn("ADMIN_API_KEY is not set — using fallback secret for DEVELOPMENT only. DO NOT use in production.");
    return "fallback-secret-for-dev";
}

// Extend Express Request object to include the user
declare module "express-serve-static-core" {
    interface Request {
        user?: TokenPayload;
    }
}

/**
 * Middleware to protect endpoints with User JWT authentication
 * Expects the `Authorization: Bearer <token>` header.
 */
export async function userAuthMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        // Skip auth if user is already attached (useful for tests)
        if (req.user) {
            return next();
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            logger.warn({ path: req.path, method: req.method, ip: req.ip }, "Missing or malformed Authorization header");
            throw new HttpError(401, "Authentication token required. Use 'Authorization: Bearer <token>' header.");
        }

        const token = authHeader.split(" ")[1];
        if (!token) {
            throw new HttpError(401, "Invalid authorization header format.");
        }

        const secret = getJwtSecret();

        let decoded: TokenPayload;
        try {
            decoded = jwt.verify(token, secret) as TokenPayload;
        } catch (_err) {
            logger.warn({ path: req.path, ip: req.ip }, "Failed JWT verification");
            throw new HttpError(401, "Invalid or expired token.");
        }

        // Verify user still exists in database
        const userRepo = getContainer(req).userRepo;
        const user = userRepo.findUserById(decoded.userId);
        if (!user) {
            logger.warn({ userId: decoded.userId }, "Token presented for deleted or unknown user");
            throw new HttpError(401, "User no longer exists");
        }

        // Attach user payload to request
        req.user = decoded;

        next();
    } catch (error) {
        next(error);
    }
}

/**
 * Role-based authorization middleware
 */
export function requireRole(role: string) {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!req.user) {
            return next(new HttpError(401, "Authentication required"));
        }

        if (req.user.role !== role && req.user.role !== 'ADMIN') {
            logger.warn({ userId: req.user.userId, requiredRole: role }, "Access denied: insufficient permissions");
            return next(new HttpError(403, "Insufficient permissions"));
        }

        next();
    };
}
