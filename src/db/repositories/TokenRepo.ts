import type {
    ZerodhaTokenRecord,
    AngelOneTokenRecord,
    TokenRecord,
} from "../DatabaseManager";
import type DatabaseManager from "../DatabaseManager";
import logger from "../../utils/logger";

// ─── Type Guards ─────────────────────────────────────────────────────────────

function isZerodhaToken(
    record: TokenRecord | undefined
): record is ZerodhaTokenRecord {
    return Boolean(
        record && "userId" in record && typeof record.userId === "string"
    );
}

function isAngelOneToken(
    record: TokenRecord | undefined
): record is AngelOneTokenRecord {
    return Boolean(
        record && "clientId" in record && typeof record.clientId === "string"
    );
}

// ─── Repository ──────────────────────────────────────────────────────────────

/**
 * TokenRepo manages authentication tokens for broker connections.
 *
 * Tokens are stored in the shared LMDB root under the "tokens" named database.
 * Keys are formatted as `<userId>:auth:<provider>`.
 *
 * Expired tokens are automatically deleted on read.
 */
export class TokenRepo {
    private readonly db: DatabaseManager;

    constructor(db: DatabaseManager) {
        this.db = db;
    }

    // ─── Zerodha ───────────────────────────────────────────────────────────────

    async saveZerodhaToken(
        userId: string,
        data: ZerodhaTokenRecord
    ): Promise<void> {
        const { tokens } = this.db.handles;
        await tokens.put(`${userId}:auth:zerodha`, data);
        logger.info({ userId }, "Zerodha token saved");
    }

    getZerodhaToken(userId: string): ZerodhaTokenRecord | null {
        const { tokens } = this.db.handles;
        const data = tokens.get(`${userId}:auth:zerodha`);

        if (!isZerodhaToken(data)) return null;

        // Check expiry
        if (new Date(data.expiresAt) < new Date()) {
            logger.warn({ userId }, "Stored Zerodha token has expired");
            // Fire-and-forget delete — caller will handle re-auth
            void this.deleteZerodhaToken(userId);
            return null;
        }

        return data;
    }

    async deleteZerodhaToken(userId: string): Promise<void> {
        const { tokens } = this.db.handles;
        await tokens.remove(`${userId}:auth:zerodha`);
        logger.info({ userId }, "Zerodha token deleted");
    }

    // ─── Angel One ─────────────────────────────────────────────────────────────

    async saveAngelOneToken(
        userId: string,
        data: AngelOneTokenRecord
    ): Promise<void> {
        const { tokens } = this.db.handles;
        await tokens.put(`${userId}:auth:angelone`, data);
        logger.info({ userId, clientId: data.clientId }, "Angel One token saved");
    }

    getAngelOneToken(userId: string): AngelOneTokenRecord | null {
        const { tokens } = this.db.handles;
        const data = tokens.get(`${userId}:auth:angelone`);

        if (!isAngelOneToken(data)) return null;

        // Check expiry
        if (new Date(data.expiresAt) < new Date()) {
            logger.warn({ userId }, "Stored Angel One token has expired");
            void this.deleteAngelOneToken(userId);
            return null;
        }

        return data;
    }

    async deleteAngelOneToken(userId: string): Promise<void> {
        const { tokens } = this.db.handles;
        await tokens.remove(`${userId}:auth:angelone`);
        logger.info({ userId }, "Angel One token deleted");
    }
}
