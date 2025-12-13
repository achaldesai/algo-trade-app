import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { NotificationService } from "./NotificationService";

describe("NotificationService", () => {
    describe("isConfigured", () => {
        it("returns false when no webhook URLs are set", () => {
            const service = new NotificationService({});
            assert.strictEqual(service.isConfigured(), false);
        });

        it("returns true when Discord webhook URL is set", () => {
            const service = new NotificationService({
                discordWebhookUrl: "https://discord.com/api/webhooks/123/abc",
            });
            assert.strictEqual(service.isConfigured(), true);
        });

        it("returns true when generic webhook URL is set", () => {
            const service = new NotificationService({
                webhookUrl: "https://example.com/webhook",
            });
            assert.strictEqual(service.isConfigured(), true);
        });

        it("returns true when both URLs are set", () => {
            const service = new NotificationService({
                discordWebhookUrl: "https://discord.com/api/webhooks/123/abc",
                webhookUrl: "https://example.com/webhook",
            });
            assert.strictEqual(service.isConfigured(), true);
        });
    });

    describe("sendTestNotification", () => {
        it("returns error when not configured", async () => {
            const service = new NotificationService({});
            const result = await service.sendTestNotification();

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.message, "No webhook URL configured");
        });
    });

    describe("public notification methods", () => {
        let service: NotificationService;

        beforeEach(() => {
            // Create service without actual webhook to prevent network calls
            service = new NotificationService({});
        });

        it("notifyTradingStarted is callable", async () => {
            // Just verifying the method exists and is async
            const result = service.notifyTradingStarted();
            assert.ok(result instanceof Promise);
            await result; // Should resolve without error
        });

        it("notifyTradingStopped is callable", async () => {
            const result = service.notifyTradingStopped();
            assert.ok(result instanceof Promise);
            await result;
        });

        it("notifyPanicSell is callable with correct params", async () => {
            const result = service.notifyPanicSell(5, 2);
            assert.ok(result instanceof Promise);
            await result;
        });
    });
});
