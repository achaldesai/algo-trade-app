import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { HttpError } from "../utils/HttpError";
import env from "../config/env";
import logger from "../utils/logger";
import { getUserRepository } from "../persistence/UserRepository";

export interface TokenPayload {
    userId: string;
    role: string;
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
            throw new HttpError(401, "Authentication token required. Use 'Authorization: Bearer <token>' header.");
        }

        const token = authHeader.split(" ")[1];
        if (!token) {
            throw new HttpError(401, "Invalid authorization header format.");
        }

        const secret = env.adminApiKey || "fallback-secret-for-dev";

        let decoded: TokenPayload;
        try {
            decoded = jwt.verify(token, secret) as TokenPayload;
        } catch (_err) {
            logger.warn({ path: req.path, ip: req.ip }, "Failed JWT verification");
            throw new HttpError(401, "Invalid or expired token.");
        }

        // Verify user still exists in database
        const userRepo = getUserRepository();
        const user = await userRepo.findUserById(decoded.userId);
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
