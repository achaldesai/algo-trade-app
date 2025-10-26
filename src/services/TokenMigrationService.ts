import { promises as fs } from "node:fs";
import path from "node:path";
import logger from "../utils/logger";
import { getTokenRepository } from "../persistence/TokenRepository";
import type { ZerodhaTokenData, AngelOneTokenData } from "../persistence/TokenRepository";

/**
 * Service to migrate tokens from file-based storage to LMDB
 * This runs once on startup and can be safely removed after migration
 */
export class TokenMigrationService {
  private readonly ZERODHA_TOKEN_FILE = path.join(process.cwd(), "data", "zerodha-token.json");
  private readonly ANGELONE_TOKEN_FILE = path.join(process.cwd(), "data", "angelone-token.json");

  /**
   * Migrate Zerodha tokens from file to LMDB
   */
  private async migrateZerodhaToken(storePath: string): Promise<boolean> {
    try {
      // Check if file exists
      await fs.access(this.ZERODHA_TOKEN_FILE);

      // Read file
      const data = await fs.readFile(this.ZERODHA_TOKEN_FILE, "utf-8");
      const tokenData = JSON.parse(data) as ZerodhaTokenData;

      // Check if token is still valid
      const expiresAt = new Date(tokenData.expiresAt);
      if (expiresAt < new Date()) {
        logger.info("Skipping expired Zerodha token migration");
        return false;
      }

      // Save to LMDB
      const tokenRepo = getTokenRepository(storePath);
      await tokenRepo.saveZerodhaToken(tokenData);

      logger.info({ userId: tokenData.userId }, "Migrated Zerodha token to LMDB");

      // Delete old file
      await fs.unlink(this.ZERODHA_TOKEN_FILE);
      logger.info("Deleted old Zerodha token file");

      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // File doesn't exist, nothing to migrate
        return false;
      }

      logger.error({ err: error }, "Failed to migrate Zerodha token");
      return false;
    }
  }

  /**
   * Migrate Angel One tokens from file to LMDB
   */
  private async migrateAngelOneToken(storePath: string): Promise<boolean> {
    try {
      // Check if file exists
      await fs.access(this.ANGELONE_TOKEN_FILE);

      // Read file
      const data = await fs.readFile(this.ANGELONE_TOKEN_FILE, "utf-8");
      const tokenData = JSON.parse(data) as AngelOneTokenData;

      // Check if token is still valid
      const expiresAt = new Date(tokenData.expiresAt);
      if (expiresAt < new Date()) {
        logger.info("Skipping expired Angel One token migration");
        return false;
      }

      // Save to LMDB
      const tokenRepo = getTokenRepository(storePath);
      await tokenRepo.saveAngelOneToken(tokenData);

      logger.info({ clientId: tokenData.clientId }, "Migrated Angel One token to LMDB");

      // Delete old file
      await fs.unlink(this.ANGELONE_TOKEN_FILE);
      logger.info("Deleted old Angel One token file");

      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // File doesn't exist, nothing to migrate
        return false;
      }

      logger.error({ err: error }, "Failed to migrate Angel One token");
      return false;
    }
  }

  /**
   * Run the migration process
   * @param storePath LMDB store path
   * @returns Number of tokens migrated
   */
  async migrate(storePath: string): Promise<number> {
    logger.info("Checking for tokens to migrate from file-based storage...");

    let migratedCount = 0;

    // Migrate Zerodha token
    if (await this.migrateZerodhaToken(storePath)) {
      migratedCount++;
    }

    // Migrate Angel One token
    if (await this.migrateAngelOneToken(storePath)) {
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
