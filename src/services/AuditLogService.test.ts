/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { AuditLogService } from "./AuditLogService";
import type { AuditLogRepository } from "../persistence/AuditLogRepository";

// Mock Repository
const mockRepository: AuditLogRepository = {
    append: mock.fn(async () => { }),
    query: mock.fn(async () => []),
    getToday: mock.fn(async () => []),
    getStats: mock.fn(async () => ({} as any)),
    cleanup: mock.fn(async () => 0),
    initialize: mock.fn(async () => { }),
    close: mock.fn(async () => { }),
};

describe("AuditLogService", () => {
    let service: AuditLogService;

    beforeEach(() => {
        // Reset singleton (hacky but needed for testing singletons)
        (AuditLogService as any).instance = null;
        service = AuditLogService.getInstance({ repository: mockRepository });
    });

    afterEach(() => {
        mock.restoreAll();
    });

    it("should be a singleton", () => {
        const instance2 = AuditLogService.getInstance();
        assert.strictEqual(service, instance2);
    });

    it("should log events safely", async () => {
        await service.logTradingStarted();
        // Verify append was called
        assert.strictEqual((mockRepository.append as any).mock.callCount(), 1);
    });

    it("should handle repository errors gracefully (retry queue)", async () => {
        // Mock failure
        (mockRepository.append as any).mock.mockImplementation(async () => {
            throw new Error("DB Error");
        });

        // Should not throw
        await service.logTradingStarted();

        // Should have tried to append at least once
        assert.ok((mockRepository.append as any).mock.callCount() >= 1);

        // Wait for potential flush attempt
        await new Promise(resolve => setTimeout(resolve, 50));

        // Queue should eventually hold the item if append keeps failing
        assert.ok((service as any).logQueue.length > 0);
    });

    it("should retry flushing queue", async () => {
        // Reset mocks
        (mockRepository.append as any).mock.resetCalls();
        (service as any).logQueue = [];

        // Mock failure then success
        let calls = 0;
        (mockRepository.append as any).mock.mockImplementation(async () => {
            calls++;
            if (calls === 1) throw new Error("DB Error");
            return; // Success on subsequent calls
        });

        await service.logTradingStarted();

        // Initial failure puts it in queue
        // Flush triggered. 
        // If flush succeeds (2nd call), queue empties.

        // Wait for flush loop to process
        await new Promise(resolve => setTimeout(resolve, 100));

        // Queue should be empty if flush succeeded
        assert.strictEqual((service as any).logQueue.length, 0);
        assert.ok(calls >= 2);
    });
});
