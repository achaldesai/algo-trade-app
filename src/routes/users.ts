import { Router, type Request, type Response } from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { getContainer } from "../util/getContainer";
import { getJwtSecret } from "../utils/jwtSecret";
import { HttpError } from "../utils/HttpError";
import logger from "../utils/logger";
import env from "../config/env";
import { userAuthMiddleware, type TokenPayload } from "../middleware/userAuth";

const router = Router();


const registerSchema = z.object({
    username: z.string().min(3).max(50),
    password: z.string().min(8),
    // Honoured only when the caller is an authenticated ADMIN.
    role: z.enum(["ADMIN", "USER"]).optional()
});

const loginSchema = z.object({
    username: z.string(),
    password: z.string()
});

/**
 * Decide which role a registration request may create. Never trusts the
 * requested role unless the caller presents a valid ADMIN JWT.
 */
function resolveRegistrationRole(
    req: Request,
    isFirstUser: boolean,
    requestedRole: "ADMIN" | "USER" | undefined
): "ADMIN" | "USER" {
    if (isFirstUser) return "ADMIN";

    const caller = getCallerFromBearer(req);
    if (caller?.role === "ADMIN") return requestedRole ?? "USER";

    if (env.nodeEnv === "production") {
        throw new HttpError(403, "Registration is closed. Ask an admin to create your account.");
    }
    if (requestedRole === "ADMIN") {
        throw new HttpError(403, "Only an admin can create admin accounts");
    }
    return "USER";
}

function getCallerFromBearer(req: Request): TokenPayload | undefined {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return undefined;
    try {
        const decoded = jwt.verify(authHeader.slice("Bearer ".length), getJwtSecret()) as TokenPayload;
        return getContainer(req).userRepo.findUserById(decoded.userId) ? decoded : undefined;
    } catch {
        return undefined;
    }
}

/**
 * POST /api/users/register
 * Register a new user.
 *
 * - The very first user becomes ADMIN (bootstrap).
 * - An authenticated ADMIN may create users with any role.
 * - Otherwise, self-signup creates a USER in development and is closed in production.
 */
router.post("/register", async (req: Request, res: Response) => {
    try {
        const data = registerSchema.parse(req.body);
        const repo = getContainer(req).userRepo;
        const role = resolveRegistrationRole(req, repo.listUsers().length === 0, data.role);

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
            role
        });

        logger.info({ userId: user.id, role }, "New user registered");

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
