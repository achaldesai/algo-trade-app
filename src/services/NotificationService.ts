import type TradingEngine from "./TradingEngine";
import type { StopLossMonitor } from "./StopLossMonitor";
import type { Trade } from "../types";
import logger from "../utils/logger";

export interface NotificationServiceOptions {
    discordWebhookUrl?: string;
    webhookUrl?: string;
    tradingEngine?: TradingEngine;
    stopLossMonitor?: StopLossMonitor;
}

interface DiscordEmbed {
    title: string;
    description?: string;
    color: number;
    fields?: { name: string; value: string; inline?: boolean }[];
    timestamp?: string;
    footer?: { text: string };
}

interface DiscordWebhookPayload {
    username?: string;
    avatar_url?: string;
    content?: string;
    embeds?: DiscordEmbed[];
}

// Discord embed colors
const COLORS = {
    SUCCESS: 0x22c55e,   // Green
    WARNING: 0xeab308,   // Yellow  
    ERROR: 0xef4444,     // Red
    INFO: 0x3b82f6,      // Blue
    ORANGE: 0xf97316,    // Orange
};

/**
 * NotificationService - Sends alerts via Discord/webhooks for trading events
 * 
 * Subscribes to:
 * - Trade executions (TradingEngine)
 * - Stop-loss triggers (StopLossMonitor)
 */
export class NotificationService {
    private readonly discordWebhookUrl: string;
    private readonly webhookUrl: string;
    private pendingNotifications: DiscordWebhookPayload[] = [];
    private batchTimeout: ReturnType<typeof setTimeout> | null = null;
    private readonly BATCH_DELAY_MS = 1000; // Batch notifications within 1 second

    constructor(options: NotificationServiceOptions) {
        this.discordWebhookUrl = options.discordWebhookUrl ?? "";
        this.webhookUrl = options.webhookUrl ?? "";

        // Subscribe to TradingEngine events
        if (options.tradingEngine) {
            options.tradingEngine.on("trade-executed", (trade: Trade) => {
                void this.notifyTradeExecuted(trade);
            });
        }

        // Subscribe to StopLossMonitor events
        if (options.stopLossMonitor) {
            options.stopLossMonitor.on("stop-loss-triggered", (event: { config: { symbol: string; stopLossPrice: number }; triggerPrice: number }) => {
                void this.notifyStopLossTriggered(event);
            });
            options.stopLossMonitor.on("stop-loss-executed", (event: { config: { symbol: string; quantity: number }; execution: unknown }) => {
                void this.notifyStopLossExecuted(event);
            });
        }

        logger.info({
            discordConfigured: !!this.discordWebhookUrl,
            webhookConfigured: !!this.webhookUrl
        }, "NotificationService initialized");
    }

    /**
     * Check if notifications are configured
     */
    isConfigured(): boolean {
        return !!(this.discordWebhookUrl || this.webhookUrl);
    }

    /**
     * Send a test notification
     */
    async sendTestNotification(): Promise<{ success: boolean; message: string }> {
        if (!this.isConfigured()) {
            return { success: false, message: "No webhook URL configured" };
        }

        const embed: DiscordEmbed = {
            title: "🧪 Test Notification",
            description: "If you see this, notifications are working correctly!",
            color: COLORS.INFO,
            timestamp: new Date().toISOString(),
            footer: { text: "Algo Trade App" },
        };

        try {
            await this.sendDiscordEmbed(embed);
            return { success: true, message: "Test notification sent successfully" };
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            return { success: false, message };
        }
    }

    /**
     * Notify about a trade execution
     */
    private async notifyTradeExecuted(trade: Trade): Promise<void> {
        const isBuy = trade.side === "BUY";
        const emoji = isBuy ? "📈" : "📉";
        const action = isBuy ? "Bought" : "Sold";

        const embed: DiscordEmbed = {
            title: `${emoji} Trade Executed`,
            description: `${action} **${trade.quantity}** shares of **${trade.symbol}**`,
            color: COLORS.SUCCESS,
            fields: [
                { name: "Symbol", value: trade.symbol, inline: true },
                { name: "Side", value: trade.side, inline: true },
                { name: "Quantity", value: trade.quantity.toString(), inline: true },
                { name: "Price", value: `₹${trade.price.toFixed(2)}`, inline: true },
                { name: "Value", value: `₹${(trade.quantity * trade.price).toFixed(2)}`, inline: true },
            ],
            timestamp: new Date().toISOString(),
            footer: { text: "Algo Trade App" },
        };

        if (trade.notes) {
            embed.fields?.push({ name: "Notes", value: trade.notes, inline: false });
        }

        await this.queueNotification({ embeds: [embed] });
    }

    /**
     * Notify about a stop-loss trigger
     */
    private async notifyStopLossTriggered(event: { config: { symbol: string; stopLossPrice: number }; triggerPrice: number }): Promise<void> {
        const embed: DiscordEmbed = {
            title: "⚠️ Stop-Loss Triggered",
            description: `Stop-loss triggered for **${event.config.symbol}**`,
            color: COLORS.WARNING,
            fields: [
                { name: "Symbol", value: event.config.symbol, inline: true },
                { name: "Stop Price", value: `₹${event.config.stopLossPrice.toFixed(2)}`, inline: true },
                { name: "Trigger Price", value: `₹${event.triggerPrice.toFixed(2)}`, inline: true },
            ],
            timestamp: new Date().toISOString(),
            footer: { text: "Algo Trade App" },
        };

        await this.queueNotification({ embeds: [embed] });
    }

    /**
     * Notify about a stop-loss execution
     */
    private async notifyStopLossExecuted(event: { config: { symbol: string; quantity: number }; execution: unknown }): Promise<void> {
        const embed: DiscordEmbed = {
            title: "🛑 Stop-Loss Executed",
            description: `Position in **${event.config.symbol}** has been closed by stop-loss`,
            color: COLORS.ORANGE,
            fields: [
                { name: "Symbol", value: event.config.symbol, inline: true },
                { name: "Quantity", value: event.config.quantity.toString(), inline: true },
            ],
            timestamp: new Date().toISOString(),
            footer: { text: "Algo Trade App" },
        };

        await this.queueNotification({ embeds: [embed] });
    }

    /**
     * Notify about trading loop start
     */
    async notifyTradingStarted(): Promise<void> {
        const embed: DiscordEmbed = {
            title: "▶️ Trading Started",
            description: "Trading loop has been started",
            color: COLORS.INFO,
            timestamp: new Date().toISOString(),
            footer: { text: "Algo Trade App" },
        };

        await this.queueNotification({ embeds: [embed] });
    }

    /**
     * Notify about trading loop stop
     */
    async notifyTradingStopped(): Promise<void> {
        const embed: DiscordEmbed = {
            title: "⏹️ Trading Stopped",
            description: "Trading loop has been stopped",
            color: COLORS.INFO,
            timestamp: new Date().toISOString(),
            footer: { text: "Algo Trade App" },
        };

        await this.queueNotification({ embeds: [embed] });
    }

    /**
     * Notify about panic sell
     */
    async notifyPanicSell(executedCount: number, failedCount: number): Promise<void> {
        const embed: DiscordEmbed = {
            title: "🚨 PANIC SELL Executed",
            description: "Emergency liquidation of all positions",
            color: COLORS.ERROR,
            fields: [
                { name: "Positions Sold", value: executedCount.toString(), inline: true },
                { name: "Failed", value: failedCount.toString(), inline: true },
            ],
            timestamp: new Date().toISOString(),
            footer: { text: "Algo Trade App" },
        };

        // Send immediately, don't batch
        await this.sendDiscordEmbed(embed);
    }

    /**
     * Queue a notification for batching
     */
    private async queueNotification(payload: DiscordWebhookPayload): Promise<void> {
        if (!this.isConfigured()) {
            return;
        }

        this.pendingNotifications.push(payload);

        // Clear existing timeout and set new one
        if (this.batchTimeout) {
            clearTimeout(this.batchTimeout);
        }

        this.batchTimeout = setTimeout(() => {
            void this.flushNotifications();
        }, this.BATCH_DELAY_MS);
    }

    /**
     * Flush all pending notifications
     */
    private async flushNotifications(): Promise<void> {
        if (this.pendingNotifications.length === 0) {
            return;
        }

        const notifications = [...this.pendingNotifications];
        this.pendingNotifications = [];

        // Combine all embeds into a single message (Discord allows up to 10)
        const allEmbeds: DiscordEmbed[] = [];
        for (const notification of notifications) {
            if (notification.embeds) {
                allEmbeds.push(...notification.embeds);
            }
        }

        // Discord limits to 10 embeds per message
        const chunks: DiscordEmbed[][] = [];
        for (let i = 0; i < allEmbeds.length; i += 10) {
            chunks.push(allEmbeds.slice(i, i + 10));
        }

        for (const chunk of chunks) {
            await this.sendPayload({
                username: "Algo Trade Bot",
                embeds: chunk
            });
        }
    }

    /**
     * Send a single Discord embed
     */
    private async sendDiscordEmbed(embed: DiscordEmbed): Promise<void> {
        await this.sendPayload({
            username: "Algo Trade Bot",
            embeds: [embed],
        });
    }

    /**
     * Send payload to webhook(s)
     */
    private async sendPayload(payload: DiscordWebhookPayload): Promise<void> {
        const urls: string[] = [];

        if (this.discordWebhookUrl) {
            urls.push(this.discordWebhookUrl);
        }

        if (this.webhookUrl) {
            urls.push(this.webhookUrl);
        }

        for (const url of urls) {
            try {
                const response = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });

                if (!response.ok) {
                    const text = await response.text();
                    logger.error({ url, status: response.status, body: text }, "Webhook request failed");
                } else {
                    logger.debug({ url }, "Notification sent successfully");
                }
            } catch (error) {
                logger.error({ err: error, url }, "Failed to send notification");
            }
        }
    }
}

export default NotificationService;
