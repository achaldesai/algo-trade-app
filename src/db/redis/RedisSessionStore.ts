import type { RedisManager } from "./RedisManager";
import logger from "../../utils/logger";

/**
 * RedisSessionStore — JWT token revocation and session tracking.
 *
 * - Revoked JWTs are stored with TTL matching the token's remaining lifetime.
 * - Active sessions are tracked per user for listing/bulk revocation.
 */
export class RedisSessionStore {
    private readonly prefix = "session:";
    private readonly revokedPrefix = "revoked:";

    constructor(private readonly redis: RedisManager) { }

    /**
     * Revoke a JWT by its token identifier (jti).
     * @param jti - Unique JWT identifier
     * @param ttlSeconds - Time until the token would naturally expire
     */
    async revokeToken(jti: string, ttlSeconds: number): Promise<void> {
        try {
            await this.redis.client.setex(
                `${this.revokedPrefix}${jti}`,
                ttlSeconds,
                "1"
            );
            logger.info({ jti }, "Token revoked");
        } catch (err) {
            logger.error({ err, jti }, "Failed to revoke token");
        }
    }

    /**
     * Check if a JWT has been revoked.
     */
    async isRevoked(jti: string): Promise<boolean> {
        try {
            const result = await this.redis.client.exists(
                `${this.revokedPrefix}${jti}`
            );
            return result === 1;
        } catch (err) {
            logger.warn({ err, jti }, "Failed to check token revocation");
            // Fail-open: if Redis is down, allow the request through
            return false;
        }
    }

    /**
     * Track an active session for a user.
     * @param userId - User ID
     * @param jti - JWT identifier
     * @param ttlSeconds - Session lifetime
     */
    async trackSession(
        userId: string,
        jti: string,
        ttlSeconds: number
    ): Promise<void> {
        try {
            const key = `${this.prefix}${userId}`;
            await this.redis.client.hset(key, jti, Date.now().toString());
            await this.redis.client.expire(key, ttlSeconds);
        } catch (err) {
            logger.warn({ err, userId }, "Failed to track session");
        }
    }

    /**
     * Get active session count for a user.
     */
    async getSessionCount(userId: string): Promise<number> {
        try {
            return await this.redis.client.hlen(`${this.prefix}${userId}`);
        } catch (err) {
            logger.warn({ err, userId }, "Failed to get session count");
            return 0;
        }
    }

    /**
     * Revoke all sessions for a user.
     * @param userId - User ID
     * @param ttlSeconds - Time remaining on each session
     */
    async revokeAllSessions(
        userId: string,
        ttlSeconds: number
    ): Promise<number> {
        try {
            const key = `${this.prefix}${userId}`;
            const sessions = await this.redis.client.hkeys(key);

            let revoked = 0;
            for (const jti of sessions) {
                await this.revokeToken(jti, ttlSeconds);
                revoked++;
            }

            await this.redis.client.del(key);
            logger.info({ userId, revoked }, "All sessions revoked");
            return revoked;
        } catch (err) {
            logger.error({ err, userId }, "Failed to revoke all sessions");
            return 0;
        }
    }
}
