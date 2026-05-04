import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import TokenMigrationService from "./TokenMigrationService";
import type { TokenRepo } from "../db/repositories/TokenRepo";

describe("TokenMigrationService", () => {
  let savedZerodhaTokens: unknown[] = [];
  let savedAngelOneTokens: unknown[] = [];
  let tokenRepo: TokenRepo;

  beforeEach(() => {
    savedZerodhaTokens = [];
    savedAngelOneTokens = [];
    tokenRepo = {
      saveZerodhaToken: async (_userId: string, data: unknown) => {
        savedZerodhaTokens.push(data);
      },
      getZerodhaToken: () => null,
      deleteZerodhaToken: async () => {},
      saveAngelOneToken: async (_userId: string, data: unknown) => {
        savedAngelOneTokens.push(data);
      },
      getAngelOneToken: () => null,
      deleteAngelOneToken: async () => {},
    } as unknown as TokenRepo;
  });

  it("should return 0 when no token files exist", async () => {
    const service = new TokenMigrationService(tokenRepo);
    // The file access will fail with ENOENT since the files don't exist
    const migratedCount = await service.migrate();
    assert.equal(migratedCount, 0);
    assert.equal(savedZerodhaTokens.length, 0);
    assert.equal(savedAngelOneTokens.length, 0);
  });

  it("should handle the migration call without errors", async () => {
    const service = new TokenMigrationService(tokenRepo);
    const result = await service.migrate();
    assert.equal(typeof result, "number");
  });
});
