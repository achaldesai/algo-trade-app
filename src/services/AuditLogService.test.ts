/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { AuditLogService } from "./AuditLogService";
import type { AuditLogRepo } from "../db/repositories/AuditLogRepo";

// Mock Repository — only need the methods AuditLogService actually calls
const createMockRepo = (): AuditLogRepo => ({
    append: mock.fn(async () => { }),
    query: mock.fn(async () => []),
    getToday: mock.fn(async () => []),
    getStats: mock.fn(async () => ({} as any)),
    cleanup: mock.fn(async () => 0),
    // AuditLogRepo has a `db` field but AuditLogService never touches it
    db: {} as any,
} as unknown as AuditLogRepo);

describe("AuditLogService", () => {
    let service: AuditLogService;
    let mockRepository: AuditLogRepo;

    beforeEach(() => {
        mockRepository = createMockRepo();
        service = new AuditLogService({ repository: mockRepository });
    });

    afterEach(() => {
        mock.restoreAll();
    });

    it("should log events safely", async () => {
        await service.logTradingStarted();
        assert.strictEqual((mockRepository.append as any).mock.callCount(), 1);
    });

    it("should handle repository errors gracefully (retry queue)", async () => {
        (mockRepository.append as any).mock.mockImplementation(async () => {
            throw new Error("DB Error");
        });

        // Should not throw
        await service.logTradingStarted();

        assert.ok((mockRepository.append as any).mock.callCount() >= 1);

        await new Promise(resolve => setTimeout(resolve, 50));

        assert.ok((service as any).logQueue.length > 0);
    });

    it("should retry flushing queue", async () => {
        (mockRepository.append as any).mock.resetCalls();
        (service as any).logQueue = [];

        let calls = 0;
        (mockRepository.append as any).mock.mockImplementation(async () => {
            calls++;
            if (calls === 1) throw new Error("DB Error");
            return;
        });

        await service.logTradingStarted();

        await new Promise(resolve => setTimeout(resolve, 100));

        assert.strictEqual((service as any).logQueue.length, 0);
        assert.ok(calls >= 2);
    });
});
