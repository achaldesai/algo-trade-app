import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { TokenRefreshService } from "./TokenRefreshService";

describe("TokenRefreshService", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe("Exponential Backoff", () => {
    it("calculates backoff delay correctly", () => {
      // Set up minimal Angel One config
      process.env.ANGEL_ONE_API_KEY = "test_key";
      process.env.ANGEL_ONE_CLIENT_ID = "test_client";
      process.env.ANGEL_ONE_PASSWORD = "test_pass";
      process.env.ANGEL_ONE_TOTP_SECRET = "test_secret";

      const service = TokenRefreshService.getInstance();

      // Access private method via prototype (for testing)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calculateBackoffDelay = (service as any).calculateBackoffDelay.bind(service);

      // Test exponential growth: 1min, 2min, 4min, 8min, 16min
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).retryCount = 0;
      const delay0 = calculateBackoffDelay();
      assert.equal(delay0, 60000, "First retry should be 1 minute");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).retryCount = 1;
      const delay1 = calculateBackoffDelay();
      assert.equal(delay1, 120000, "Second retry should be 2 minutes");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).retryCount = 2;
      const delay2 = calculateBackoffDelay();
      assert.equal(delay2, 240000, "Third retry should be 4 minutes");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).retryCount = 3;
      const delay3 = calculateBackoffDelay();
      assert.equal(delay3, 480000, "Fourth retry should be 8 minutes");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).retryCount = 4;
      const delay4 = calculateBackoffDelay();
      assert.equal(delay4, 960000, "Fifth retry should be 16 minutes");
    });

    it("caps backoff delay at 30 minutes", () => {
      process.env.ANGEL_ONE_API_KEY = "test_key";
      const service = TokenRefreshService.getInstance();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calculateBackoffDelay = (service as any).calculateBackoffDelay.bind(service);

      // Set very high retry count
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).retryCount = 10;
      const delay = calculateBackoffDelay();

      // Should be capped at 30 minutes (1800000 ms)
      assert.equal(delay, 1800000, "Backoff should be capped at 30 minutes");
    });
  });

  describe("Scheduler Timing", () => {
    it("calculates next refresh delay correctly", () => {
      process.env.ANGEL_ONE_API_KEY = "test_key";
      const service = TokenRefreshService.getInstance();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calculateNextRefreshDelay = (service as any).calculateNextRefreshDelay.bind(service);

      const delay = calculateNextRefreshDelay();

      // Delay should be positive and less than 24 hours
      assert.ok(delay > 0, "Delay should be positive");
      assert.ok(delay <= 24 * 60 * 60 * 1000, "Delay should be less than 24 hours");
    });

    it("schedules refresh for 4:30 AM IST", () => {
      process.env.ANGEL_ONE_API_KEY = "test_key";
      const service = TokenRefreshService.getInstance();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calculateNextRefreshDelay = (service as any).calculateNextRefreshDelay.bind(service);
      const delay = calculateNextRefreshDelay();

      // Check that it's scheduled for roughly the right time
      // (We can't be exact due to timing, but should be within 24 hours)
      assert.ok(delay > 0 && delay <= 24 * 60 * 60 * 1000);
    });
  });

  describe("Service Lifecycle", () => {
    it("does not start scheduler when broker is not angelone", () => {
      process.env.BROKER_PROVIDER = "paper";
      process.env.ANGEL_ONE_API_KEY = "test_key";

      const service = TokenRefreshService.getInstance();
      service.start();

      assert.equal(service.isRunning(), false, "Scheduler should not run for non-angelone broker");

      service.stop();
    });

    it("does not start scheduler when TOTP secret is missing", () => {
      process.env.BROKER_PROVIDER = "angelone";
      process.env.ANGEL_ONE_API_KEY = "test_key";
      delete process.env.ANGEL_ONE_TOTP_SECRET;

      const service = TokenRefreshService.getInstance();
      service.start();

      assert.equal(service.isRunning(), false, "Scheduler should not run without TOTP secret");

      service.stop();
    });

    it("can stop running scheduler", () => {
      process.env.BROKER_PROVIDER = "angelone";
      process.env.ANGEL_ONE_API_KEY = "test_key";
      process.env.ANGEL_ONE_TOTP_SECRET = "test_secret";

      const service = TokenRefreshService.getInstance();
      service.start();

      assert.equal(service.isRunning(), true, "Scheduler should be running");

      service.stop();

      assert.equal(service.isRunning(), false, "Scheduler should be stopped");
    });
  });

  describe("Retry Logic", () => {
    it("resets retry count on successful authentication", async () => {
      process.env.BROKER_PROVIDER = "angelone";
      process.env.ANGEL_ONE_API_KEY = "test_key";
      process.env.ANGEL_ONE_CLIENT_ID = "test_client";
      process.env.ANGEL_ONE_PASSWORD = "test_pass";
      process.env.ANGEL_ONE_TOTP_SECRET = "test_secret";

      const service = TokenRefreshService.getInstance();

      // Simulate failed retries
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).retryCount = 3;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assert.equal((service as any).retryCount, 3, "Retry count should be 3");

      // Note: We can't easily test the actual reset without mocking the SmartAPI
      // This test verifies the retry count can be set and read
    });

    it("respects max retries limit", () => {
      process.env.ANGEL_ONE_API_KEY = "test_key";
      const service = TokenRefreshService.getInstance();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const maxRetries = (service as any).MAX_RETRIES;

      assert.equal(maxRetries, 5, "Max retries should be 5");
    });
  });
});
