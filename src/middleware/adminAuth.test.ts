import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";
import type { Request, Response, NextFunction } from "express";
import { adminAuthMiddleware } from "./adminAuth";
import { HttpError } from "../utils/HttpError";
import env from "../config/env";
import jwt from "jsonwebtoken";
import { getJwtSecret } from "../utils/jwtSecret";

describe("Admin Auth Middleware", () => {
    let req: Partial<Request>;
    let res: Partial<Response>;
    type MockNext = NextFunction & { mock: { callCount: () => number, calls: { arguments: unknown[] }[] } };
    let next: MockNext;

    beforeEach(() => {
        req = {
            headers: {},
            path: "/api/admin/test",
            ip: "127.0.0.1",
        };
        res = {};
        next = mock.fn() as unknown as MockNext;
        // Reset env var for testing (mocking might be needed if env is frozen)
        // Assuming env is a mutable object or we can property descriptor mock it.
        // However, env is likely imported. We might need to rely on the actual or mock it in a complex way.
        // For simplicity, we assume we can set it or it has a default.
        // If env is read-only, we might fail here.
        // Let's assume env.adminApiKey is writable for tests or we can mock the import.
        // Since we can't easily mock imports in this setup without a test runner hook,
        // we will assume a known key or try to overwrite.
    });

    // Mocking env import if possible, or just proceeding if valid.
    // We'll trust that we can't easily change env here without rewiring.
    // Instead, let's verify logic assuming ADMIN_API_KEY is set (standard in test env)
    // or use what's there.

    // Actually, we can assign to the property if it's not readonly.
    // If it is, we need another way.

    it("should throw 503 if ADMIN_API_KEY is not configured", async () => {
        const originalKey = env.adminApiKey;
        env.adminApiKey = "";

        try {
            await adminAuthMiddleware(req as Request, res as Response, next);
            assert.strictEqual(next.mock.callCount(), 1);
            const err = next.mock.calls[0].arguments[0] as HttpError;
            assert.ok(err instanceof HttpError);
            assert.strictEqual(err.statusCode, 503);
        } finally {
            env.adminApiKey = originalKey;
        }
    });

    it("should throw 401 if header is missing", async () => {
        const originalKey = env.adminApiKey;
        env.adminApiKey = "secret";

        try {
            await adminAuthMiddleware(req as Request, res as Response, next);
            assert.strictEqual(next.mock.callCount(), 1);
            const err = next.mock.calls[0].arguments[0] as HttpError;
            assert.ok(err instanceof HttpError);
            assert.strictEqual(err.statusCode, 401);
        } finally {
            env.adminApiKey = originalKey;
        }
    });

    it("should throw 403 if key is incorrect", async () => {
        const originalKey = env.adminApiKey;
        env.adminApiKey = "secret";
        req.headers!["x-admin-api-key"] = "wrong-secret";

        try {
            await adminAuthMiddleware(req as Request, res as Response, next);
            assert.strictEqual(next.mock.callCount(), 1);
            const err = next.mock.calls[0].arguments[0] as HttpError;
            assert.ok(err instanceof HttpError);
            assert.strictEqual(err.statusCode, 403);
        } finally {
            env.adminApiKey = originalKey;
        }
    });

    it("should call next() if key is correct", async () => {
        const originalKey = env.adminApiKey;
        env.adminApiKey = "secret";
        req.headers!["x-admin-api-key"] = "secret";

        try {
            await adminAuthMiddleware(req as Request, res as Response, next);
            assert.strictEqual(next.mock.callCount(), 1);
            assert.strictEqual(next.mock.calls[0].arguments[0], undefined);
        } finally {
            env.adminApiKey = originalKey;
        }
    });

    it("should throw 403 (not 401) for a valid non-admin JWT", async () => {
        const originalKey = env.adminApiKey;
        env.adminApiKey = "secret";
        const token = jwt.sign({ userId: "u1", role: "USER" }, getJwtSecret());
        req.headers!["authorization"] = `Bearer ${token}`;

        try {
            await adminAuthMiddleware(req as Request, res as Response, next);
            assert.strictEqual(next.mock.callCount(), 1);
            const err = next.mock.calls[0].arguments[0] as HttpError;
            assert.ok(err instanceof HttpError);
            assert.strictEqual(err.statusCode, 403);
        } finally {
            env.adminApiKey = originalKey;
        }
    });

    it("should still throw 401 for an invalid JWT", async () => {
        const originalKey = env.adminApiKey;
        env.adminApiKey = "secret";
        req.headers!["authorization"] = `Bearer ${jwt.sign({ userId: "u1", role: "USER" }, "other-secret")}`;

        try {
            await adminAuthMiddleware(req as Request, res as Response, next);
            const err = next.mock.calls[0].arguments[0] as HttpError;
            assert.strictEqual(err.statusCode, 401);
        } finally {
            env.adminApiKey = originalKey;
        }
    });

    it("should prevent timing attacks (length leak check logic only)", async () => {
        // This is hard to test deterministically, but we verify it works with different lengths
        const originalKey = env.adminApiKey;
        env.adminApiKey = "secret";
        req.headers!["x-admin-api-key"] = "very-long-secret-key-mismatch";

        try {
            await adminAuthMiddleware(req as Request, res as Response, next);
            assert.strictEqual(next.mock.callCount(), 1);
            const err = next.mock.calls[0].arguments[0] as HttpError;
            assert.ok(err instanceof HttpError);
            assert.strictEqual(err.statusCode, 403);
        } finally {
            env.adminApiKey = originalKey;
        }
    });
});
