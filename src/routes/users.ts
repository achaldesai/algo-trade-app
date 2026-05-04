import { Router, type Request, type Response } from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { getContainer } from "../util/getContainer";
import { HttpError } from "../utils/HttpError";
import logger from "../utils/logger";
import env from "../config/env";
import { userAuthMiddleware } from "../middleware/userAuth";

const router = Router();

function getJwtSecret(): string {
  if (env.adminApiKey) return env.adminApiKey;

  if (env.nodeEnv === "production") {
    throw new HttpError(503, "Authentication is not configured. Set ADMIN_API_KEY in environment variables.");
  }

  logger.warn("ADMIN_API_KEY is not set — using fallback secret for DEVELOPMENT only. DO NOT use in production.");
  return "fallback-secret-for-dev";
}

const registerSchema = z.object({
    username: z.string().min(3).max(50),
    password: z.string().min(8),
    role: z.enum(["ADMIN", "USER"]).optional().default("USER")
});

const loginSchema = z.object({
    username: z.string(),
    password: z.string()
});

/**
 * POST /api/users/register
 * Register a new user
 * Note: In a real production app, admin registration should be locked down.
 */
router.post("/register", async (req: Request, res: Response) => {
    try {
        const data = registerSchema.parse(req.body);
        const repo = getContainer(req).userRepo;

        // Check if username already exists
        const existing = repo.findUserByUsername(data.username);
        if (existing) {
            throw new HttpError(409, "Username already exists");
        }

        // Hash password
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(data.password, saltRounds);

        const user = await repo.createUser({
            username: data.username,
            passwordHash,
            role: data.role
        });

        logger.info({ userId: user.id }, "New user registered");

        // Return without password hash
        res.status(201).json({
            success: true,
            data: {
                id: user.id,
                username: user.username,
                role: user.role,
                createdAt: user.createdAt
            }
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            res.status(400).json({ success: false, error: "Validation failed", details: error.errors });
        } else {
            const status = error instanceof HttpError ? error.statusCode : 500;
            const message = error instanceof Error ? error.message : "Internal server error";
            res.status(status).json({ success: false, error: message });
        }
    }
});

/**
 * POST /api/users/login
 * Log in and receive a JWT
 */
router.post("/login", async (req: Request, res: Response) => {
    try {
        const data = loginSchema.parse(req.body);
        const repo = getContainer(req).userRepo;

        const user = repo.findUserByUsername(data.username);
        if (!user) {
            throw new HttpError(401, "Invalid username or password");
        }

        const passwordMatch = await bcrypt.compare(data.password, user.passwordHash);
        if (!passwordMatch) {
            throw new HttpError(401, "Invalid username or password");
        }

        const secret = getJwtSecret();

        // Create JWT token valid for 24 hours
        const token = jwt.sign(
            { userId: user.id, role: user.role },
            secret,
            { expiresIn: "24h" }
        );

        logger.info({ userId: user.id }, "User logged in");

        res.json({
            success: true,
            data: {
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    role: user.role
                }
            }
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            res.status(400).json({ success: false, error: "Validation failed", details: error.errors });
        } else {
            const status = error instanceof HttpError ? error.statusCode : 500;
            const message = error instanceof Error ? error.message : "Internal server error";
            res.status(status).json({ success: false, error: message });
        }
    }
});

/**
 * GET /api/users/me
 * Get current logged in user profile
 */
router.get("/me", userAuthMiddleware, async (req: Request, res: Response) => {
    try {
        if (!req.user) throw new HttpError(401, "Not authenticated");

        const repo = getContainer(req).userRepo;
        const user = repo.findUserById(req.user.userId);

        if (!user) {
            throw new HttpError(404, "User not found");
        }

        res.json({
            success: true,
            data: {
                id: user.id,
                username: user.username,
                role: user.role,
                createdAt: user.createdAt
            }
        });
    } catch (error) {
        const status = error instanceof HttpError ? error.statusCode : 500;
        const message = error instanceof Error ? error.message : "Internal server error";
        res.status(status).json({ success: false, error: message });
    }
});

export default router;
