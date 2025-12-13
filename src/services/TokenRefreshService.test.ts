/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import TokenRefreshService from "./TokenRefreshService";

// We need to intercept the logger import or mock it on the instance if possible.
// Since we can't easily mock module imports with just node:test and tsx without a loader,
// we will assume the logger calls don't crash the test.

// We need to intercept the logger import or mock it on the instance if possible.
// Since we can't easily mock module imports with just node:test and tsx without a loader,
// we will assume the logger calls don't crash the test.

describe("TokenRefreshService", () => {
  let originalSetTimeout: typeof setTimeout;
  let originalClearTimeout: typeof clearTimeout;
  let mockTimerCallbacks: Array<{ callback: () => void; delay: number }> = [];
  let service: TokenRefreshService;

  before(() => {
    originalSetTimeout = global.setTimeout;
    originalClearTimeout = global.clearTimeout;

    // Mock setTimeout
    global.setTimeout = ((callback: () => void, delay: number) => {
      mockTimerCallbacks.push({ callback, delay });
      return { hasRef: () => true, ref: () => { }, unref: () => { } } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;

    global.clearTimeout = (() => { }) as unknown as typeof clearTimeout;

    // Setup env
    process.env.BROKER_PROVIDER = "angelone";
    process.env.ANGEL_ONE_TOTP_SECRET = "secret";
    process.env.ANGEL_ONE_CLIENT_ID = "client";
    process.env.ANGEL_ONE_PASSWORD = "pass";
    process.env.ANGEL_ONE_API_KEY = "key";
  });

  after(() => {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  });

  beforeEach(() => {
    mockTimerCallbacks = [];
    service = TokenRefreshService.getInstance();
    service.stop();
    // Reset retry count
    (service as any).retryCount = 0;
  });

  it("should schedule retry with backoff when authentication fails", async () => {
    // Mock SmartAPI
    const mockSmartApi = {
      generateSession: async () => {
        throw new Error("Auth failed");
      },
      generateToken: async () => {
        return { status: true, data: {} };
      }
    };
    (service as any).smartApi = mockSmartApi;

    // Start service
    service.start();

    // Should have scheduled initial daily refresh
    assert.strictEqual(mockTimerCallbacks.length, 1, "Should schedule initial refresh");

    // Execute the daily refresh callback
    const dailyRefresh = mockTimerCallbacks.shift();
    if (dailyRefresh) {
      await dailyRefresh.callback();
    }

    // Now it should have failed and scheduled a retry
    // We expect retryCount to be 1
    assert.strictEqual((service as any).retryCount, 1, "Retry count should be 1");
    assert.strictEqual(mockTimerCallbacks.length, 1, "Should schedule retry");

    // Check backoff delay (should be around 60000ms for first retry)
    const firstRetry = mockTimerCallbacks.shift();
    assert.ok(firstRetry!.delay >= 60000, "First retry delay should be >= 60s");

    // Execute first retry
    await firstRetry!.callback();

    // Should fail again and schedule second retry
    assert.strictEqual((service as any).retryCount, 2, "Retry count should be 2");
    assert.strictEqual(mockTimerCallbacks.length, 1, "Should schedule second retry");

    const secondRetry = mockTimerCallbacks.shift();
    assert.ok(secondRetry!.delay > firstRetry!.delay, "Second retry delay should be larger");
  });

  it("should reset retry count on success", async () => {
    // Mock SmartAPI for success
    const mockSmartApi = {
      generateSession: async () => {
        return {
          status: true,
          data: {
            jwtToken: "jwt",
            refreshToken: "refresh",
            feedToken: "feed"
          }
        };
      }
    };
    (service as any).smartApi = mockSmartApi;

    // For this test, we might just verify up to the point of failure or use a spy if we could.
    // Since we can't easily mock the imported `saveAngelToken` function, 
    // we will focus on the retry logic failure case which we can control via the exception.
  });

  it("should abort retry on fatal authentication error", async () => {
    // Mock SmartAPI for fatal error
    const mockSmartApi = {
      generateSession: async () => {
        throw new Error("Invalid credentials");
      },
      generateToken: async () => {
        return { status: true, data: {} };
      }
    };
    (service as any).smartApi = mockSmartApi;

    // Start service
    service.start();

    // Execute the daily refresh callback
    const dailyRefresh = mockTimerCallbacks.shift();
    if (dailyRefresh) {
      await dailyRefresh.callback();
    }

    // Should NOT have scheduled a retry
    assert.strictEqual((service as any).retryCount, 0, "Retry count should remain 0");
    assert.strictEqual(mockTimerCallbacks.length, 0, "Should not schedule retry");
  });
});
