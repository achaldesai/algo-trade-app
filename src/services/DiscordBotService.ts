import { Client, GatewayIntentBits, Events } from "discord.js";
import { TunnelService } from "./TunnelService";
import logger from "../utils/logger";

export class DiscordBotService {
    private client: Client;
    private token: string;
    private tunnelService: TunnelService;

    constructor(options: { token: string; tunnelService: TunnelService }) {
        this.token = options.token;
        this.tunnelService = options.tunnelService;

        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages
            ]
        });

        this.setupListeners();
    }

    private setupListeners(): void {
        this.client.on(Events.ClientReady, () => {
            logger.info({ tag: this.client.user?.tag }, "Discord Bot ready");
        });

        this.client.on(Events.MessageCreate, async (message) => {
            if (message.author.bot) return;

            // Command: !dashboard
            if (message.content.trim() === "!dashboard") {
                try {
                    await message.reply("Opening secure tunnel... ⏳");

                    const url = await this.tunnelService.start(3000, 15); // 15 mins

                    await message.reply({
                        content: "✅ **Dashboard Live** (expires in 15m)\n" + url
                    });
                } catch (_error) {
                    await message.reply("❌ Failed to start tunnel. Check logs.");
                }
            }

            // Command: !stop
            if (message.content.trim() === "!stop") {
                await this.tunnelService.stop();
                await message.reply("🛑 Tunnel closed.");
            }
        });
    }

    async start(): Promise<void> {
        if (!this.token) {
            logger.warn("No Discord Bot Token provided. Remote access disabled.");
            return;
        }

        try {
            await this.client.login(this.token);
        } catch (error) {
            logger.error({ err: error }, "Failed to login Discord Bot");
        }
    }
}
