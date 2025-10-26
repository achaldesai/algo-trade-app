import { open, type Database } from "lmdb";
import path from "node:path";
import logger from "../utils/logger";

/**
 * Zerodha/KiteConnect token data
 */
export interface ZerodhaTokenData {
  accessToken: string;
  expiresAt: string;
  userId: string;
  apiKey: string;
}

/**
 * Angel One SmartAPI token data
 */
export interface AngelOneTokenData {
  jwtToken: string;
  refreshToken: string;
  feedToken: string;
  clientId: string;
  expiresAt: string;
}

/**
 * Generic token storage interface
 */
export interface TokenRepository {
  // Zerodha tokens
  saveZerodhaToken(data: ZerodhaTokenData): Promise<void>;
  getZerodhaToken(): Promise<ZerodhaTokenData | null>;
  deleteZerodhaToken(): Promise<void>;

  // Angel One tokens
  saveAngelOneToken(data: AngelOneTokenData): Promise<void>;
  getAngelOneToken(): Promise<AngelOneTokenData | null>;
  deleteAngelOneToken(): Promise<void>;

  // Utility
  close(): void;
}

/**
 * LMDB-based token repository
 * Stores authentication tokens in the same LMDB database as portfolio data
 */
type StoredTokenRecord = ZerodhaTokenData | AngelOneTokenData;

const isZerodhaTokenData = (
  record: StoredTokenRecord | undefined | null
): record is ZerodhaTokenData => {
  return Boolean(record && "userId" in record && typeof record.userId === "string");
};

const isAngelOneTokenData = (
  record: StoredTokenRecord | undefined | null
): record is AngelOneTokenData => {
  return Boolean(record && "clientId" in record && typeof record.clientId === "string");
};

export class LmdbTokenRepository implements TokenRepository {
  private db: Database<StoredTokenRecord> | null = null;
  private initPromise: Promise<Database<StoredTokenRecord>> | null = null;

  private readonly ZERODHA_KEY = "auth:zerodha";
  private readonly ANGELONE_KEY = "auth:angelone";

  constructor(private readonly storePath: string) {}

  /**
   * Initialize the LMDB database
   * Uses a promise to prevent race conditions on concurrent initialization
   */
  private async ensureDb(): Promise<Database<StoredTokenRecord>> {
    // If already initialized, return existing instance
    if (this.db) {
      return this.db;
    }

    // If initialization is in progress, wait for it
    if (this.initPromise) {
      return this.initPromise;
    }

    // Start initialization
    this.initPromise = (async () => {
      const dbPath = path.join(this.storePath, "tokens");

      this.db = open({
        path: dbPath,
        compression: true,
      });

      logger.debug({ dbPath }, "Token repository database initialized");
      return this.db;
    })();

    try {
      return await this.initPromise;
    } finally {
      // Clear the promise after initialization completes (success or failure)
      this.initPromise = null;
    }
  }

  /**
   * Save Zerodha token
   */
  async saveZerodhaToken(data: ZerodhaTokenData): Promise<void> {
    const db = await this.ensureDb();
    await db.put(this.ZERODHA_KEY, data);
    logger.info({ userId: data.userId }, "Zerodha token saved to LMDB");
  }

  /**
   * Get Zerodha token
   */
  async getZerodhaToken(): Promise<ZerodhaTokenData | null> {
    const db = await this.ensureDb();
    const data = db.get(this.ZERODHA_KEY);

    if (!isZerodhaTokenData(data)) {
      return null;
    }

    // Check if token is expired
    const expiresAt = new Date(data.expiresAt);
    if (expiresAt < new Date()) {
      logger.warn("Stored Zerodha token has expired");
      await this.deleteZerodhaToken();
      return null;
    }

    return data;
  }

  /**
   * Delete Zerodha token
   */
  async deleteZerodhaToken(): Promise<void> {
    const db = await this.ensureDb();
    await db.remove(this.ZERODHA_KEY);
    logger.info("Zerodha token deleted from LMDB");
  }

  /**
   * Save Angel One token
   */
  async saveAngelOneToken(data: AngelOneTokenData): Promise<void> {
    const db = await this.ensureDb();
    await db.put(this.ANGELONE_KEY, data);
    logger.info({ clientId: data.clientId }, "Angel One token saved to LMDB");
  }

  /**
   * Get Angel One token
   */
  async getAngelOneToken(): Promise<AngelOneTokenData | null> {
    const db = await this.ensureDb();
    const data = db.get(this.ANGELONE_KEY);

    if (!isAngelOneTokenData(data)) {
      return null;
    }

    // Check if token is expired
    const expiresAt = new Date(data.expiresAt);
    if (expiresAt < new Date()) {
      logger.warn("Stored Angel One token has expired");
      await this.deleteAngelOneToken();
      return null;
    }

    return data;
  }

  /**
   * Delete Angel One token
   */
  async deleteAngelOneToken(): Promise<void> {
    const db = await this.ensureDb();
    await db.remove(this.ANGELONE_KEY);
    logger.info("Angel One token deleted from LMDB");
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * In-memory token repository (for testing or file-based backends)
 */
export class InMemoryTokenRepository implements TokenRepository {
  private zerodhaToken: ZerodhaTokenData | null = null;
  private angelOneToken: AngelOneTokenData | null = null;

  async saveZerodhaToken(data: ZerodhaTokenData): Promise<void> {
    this.zerodhaToken = data;
  }

  async getZerodhaToken(): Promise<ZerodhaTokenData | null> {
    if (!this.zerodhaToken) {
      return null;
    }

    // Check expiry
    const expiresAt = new Date(this.zerodhaToken.expiresAt);
    if (expiresAt < new Date()) {
      this.zerodhaToken = null;
      return null;
    }

    return this.zerodhaToken;
  }

  async deleteZerodhaToken(): Promise<void> {
    this.zerodhaToken = null;
  }

  async saveAngelOneToken(data: AngelOneTokenData): Promise<void> {
    this.angelOneToken = data;
  }

  async getAngelOneToken(): Promise<AngelOneTokenData | null> {
    if (!this.angelOneToken) {
      return null;
    }

    // Check expiry
    const expiresAt = new Date(this.angelOneToken.expiresAt);
    if (expiresAt < new Date()) {
      this.angelOneToken = null;
      return null;
    }

    return this.angelOneToken;
  }

  async deleteAngelOneToken(): Promise<void> {
    this.angelOneToken = null;
  }

  close(): void {
    // Nothing to close for in-memory
  }
}

// Singleton instance
let tokenRepository: TokenRepository | null = null;

/**
 * Get or create the token repository instance
 */
export function getTokenRepository(storePath?: string): TokenRepository {
  if (!tokenRepository) {
    if (storePath) {
      tokenRepository = new LmdbTokenRepository(storePath);
    } else {
      // Fallback to in-memory for testing
      tokenRepository = new InMemoryTokenRepository();
    }
  }
  return tokenRepository;
}

/**
 * Reset the token repository (useful for testing)
 */
export function resetTokenRepository(): void {
  if (tokenRepository) {
    tokenRepository.close();
    tokenRepository = null;
  }
}

export default TokenRepository;
