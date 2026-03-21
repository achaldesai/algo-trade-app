/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import TokenRefreshService from "./TokenRefreshService";

describe("TokenRefreshService", () => {
  let originalSetTimeout: typeof setTimeout;
  let originalClearTimeout: typeof clearTimeout;
  let mockTimerCallbacks: Array<{ callback: () => Promise<void> | void; delay: number }> = [];
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
    let attempts = 0;
    (service as any).performReauthentication = async () => {
      attempts += 1;
      throw new Error("Auth failed");
    };

    service.start();
    assert.strictEqual(mockTimerCallbacks.length, 1, "Should schedule initial refresh");

    const dailyRefresh = mockTimerCallbacks.shift();
    if (dailyRefresh) {
      await dailyRefresh.callback();
    }

    assert.strictEqual((service as any).retryCount, 1, "Retry count should be 1");
    assert.strictEqual(mockTimerCallbacks.length, 1, "Should schedule retry");
    assert.strictEqual(attempts, 1, "Should attempt re-authentication once");

    const firstRetry = mockTimerCallbacks.shift();
    assert.ok(firstRetry!.delay >= 60000, "First retry delay should be >= 60s");

    await firstRetry!.callback();

    assert.strictEqual((service as any).retryCount, 2, "Retry count should be 2");
    assert.strictEqual(mockTimerCallbacks.length, 1, "Should schedule second retry");
    assert.strictEqual(attempts, 2, "Should attempt re-authentication twice");

    const secondRetry = mockTimerCallbacks.shift();
    assert.ok(secondRetry!.delay > firstRetry!.delay, "Second retry delay should be larger");
  });

  it("should reset retry count on success", async () => {
    (service as any).retryCount = 3;
    let attempts = 0;
    (service as any).performReauthentication = async () => {
      attempts += 1;
    };

    service.start();
    const dailyRefresh = mockTimerCallbacks.shift();
    if (dailyRefresh) {
      await dailyRefresh.callback();
    }

    assert.strictEqual(attempts, 1, "Should perform one re-authentication attempt");
    assert.strictEqual((service as any).retryCount, 0, "Retry count should reset on success");
    assert.strictEqual(mockTimerCallbacks.length, 1, "Should schedule next daily refresh");
  });

  it("should abort retry on fatal authentication error", async () => {
    (service as any).performReauthentication = async () => {
      throw new Error("Invalid credentials");
    };

    service.start();

    const dailyRefresh = mockTimerCallbacks.shift();
    if (dailyRefresh) {
      await dailyRefresh.callback();
    }

    assert.strictEqual((service as any).retryCount, 0, "Retry count should remain 0");
    assert.strictEqual(mockTimerCallbacks.length, 0, "Should not schedule retry");
  });
});
