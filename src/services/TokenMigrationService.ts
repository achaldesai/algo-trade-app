import { promises as fs } from "node:fs";
import path from "node:path";
import logger from "../utils/logger";
import type { TokenRepo } from "../db/repositories/TokenRepo";
import type { ZerodhaTokenData, AngelOneTokenData } from "../types/tokens";

/**
 * Service to migrate tokens from file-based storage to LMDB
 * This runs once on startup and can be safely removed after migration
 */
export class TokenMigrationService {
  private readonly ZERODHA_TOKEN_FILE = path.join(process.cwd(), "data", "zerodha-token.json");
  private readonly ANGELONE_TOKEN_FILE = path.join(process.cwd(), "data", "angelone-token.json");
  private readonly tokenRepo: TokenRepo;

  constructor(tokenRepo: TokenRepo) {
    this.tokenRepo = tokenRepo;
  }

  /**
   * Migrate Zerodha tokens from file to LMDB
   */
  private async migrateZerodhaToken(): Promise<boolean> {
    try {
      await fs.access(this.ZERODHA_TOKEN_FILE);

      const data = await fs.readFile(this.ZERODHA_TOKEN_FILE, "utf-8");
      const tokenData = JSON.parse(data) as ZerodhaTokenData;

      const expiresAt = new Date(tokenData.expiresAt);
      if (expiresAt < new Date()) {
        logger.info("Skipping expired Zerodha token migration");
        return false;
      }

      await this.tokenRepo.saveZerodhaToken("SYSTEM_DEFAULT", tokenData);
      logger.info({ userId: tokenData.userId }, "Migrated Zerodha token to LMDB");

      await fs.unlink(this.ZERODHA_TOKEN_FILE);
      logger.info("Deleted old Zerodha token file");

      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      logger.error({ err: error }, "Failed to migrate Zerodha token");
      return false;
    }
  }

  /**
   * Migrate Angel One tokens from file to LMDB
   */
  private async migrateAngelOneToken(): Promise<boolean> {
    try {
      await fs.access(this.ANGELONE_TOKEN_FILE);

      const data = await fs.readFile(this.ANGELONE_TOKEN_FILE, "utf-8");
      const tokenData = JSON.parse(data) as AngelOneTokenData;

      const expiresAt = new Date(tokenData.expiresAt);
      if (expiresAt < new Date()) {
        logger.info("Skipping expired Angel One token migration");
        return false;
      }

      await this.tokenRepo.saveAngelOneToken("SYSTEM_DEFAULT", tokenData);
      logger.info({ clientId: tokenData.clientId }, "Migrated Angel One token to LMDB");

      await fs.unlink(this.ANGELONE_TOKEN_FILE);
      logger.info("Deleted old Angel One token file");

      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      logger.error({ err: error }, "Failed to migrate Angel One token");
      return false;
    }
  }

  /**
   * Run the migration process.
   * @returns Number of tokens migrated
   */
  async migrate(): Promise<number> {
    logger.info("Checking for tokens to migrate from file-based storage...");

    let migratedCount = 0;

    if (await this.migrateZerodhaToken()) {
      migratedCount++;
    }

    if (await this.migrateAngelOneToken()) {
      migratedCount++;
    }

    if (migratedCount > 0) {
      logger.info({ count: migratedCount }, "Token migration completed");
    } else {
      logger.debug("No tokens to migrate");
    }

    return migratedCount;
  }
}

export default TokenMigrationService;
