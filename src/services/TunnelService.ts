import { startTunnel, Tunnel } from "untun";
import logger from "../utils/logger";

export class TunnelService {
    private url: string | null = null;
    private timer: NodeJS.Timeout | null = null;
    private tunnel: Tunnel | null = null;

    constructor() {
        // No auth token needed for Cloudflare Quick Tunnels
    }

    /**
     * Start a tunnel for a specified duration
     * @param port Port to forward
     * @param durationMinutes Duration in minutes before auto-closing
     * @returns The public tunnel URL
     */
    async start(port: number, durationMinutes: number = 15): Promise<string> {
        try {
            // Close existing tunnel if any
            if (this.url) {
                await this.stop();
            }

            // Start new Cloudflare tunnel
            const tunnel = await startTunnel({ port });

            if (!tunnel) {
                throw new Error("Failed to start Cloudflare tunnel");
            }

            this.tunnel = tunnel;
            this.url = await tunnel.getURL();

            logger.info({ url: this.url, duration: durationMinutes }, "Cloudflare Tunnel started");

            // clear existing timer
            if (this.timer) clearTimeout(this.timer);

            // Set auto-close timer
            this.timer = setTimeout(() => {
                void this.stop();
            }, durationMinutes * 60 * 1000);

            return this.url;
        } catch (error) {
            logger.error({ err: error }, "Failed to start tunnel");
            throw error;
        }
    }

    /**
     * Stop the current tunnel
     */
    async stop(): Promise<void> {
        if (!this.url) return;

        try {
            if (this.tunnel) {
                await this.tunnel.close();
            }
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = null;
            }
            logger.info("Tunnel stopped");
            this.url = null;
            this.tunnel = null;
        } catch (error) {
            logger.error({ err: error }, "Failed to stop tunnel");
        }
    }

    /**
     * Get current tunnel URL
     */
    getUrl(): string | null {
        return this.url;
    }
}
