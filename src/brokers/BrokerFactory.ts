import type BrokerClient from "./BrokerClient";
import ZerodhaBroker from "./ZerodhaBroker";
import AngelOneBroker from "./AngelOneBroker";
import PaperBroker from "./PaperBroker";
import env from "../config/env";
import type { TokenRepo } from "../db/repositories/TokenRepo";
import logger from "../utils/logger";

const RETRY_COOLDOWN_MS = 30_000;

/**
 * Per-user broker cache. Keeps a single live broker instance per userId
 * and reuses it across calls (matches old static-singleton behavior).
 */
export class BrokerFactory {
    private readonly tokenRepo: TokenRepo;
    private readonly priceLookup?: (symbol: string) => number | undefined;
    private readonly instances = new Map<string, BrokerClient>();
    private readonly connectFailures = new Map<string, number>();

    constructor(tokenRepo: TokenRepo, priceLookup?: (symbol: string) => number | undefined) {
        this.tokenRepo = tokenRepo;
        this.priceLookup = priceLookup;
    }

    async getBroker(userId: string): Promise<BrokerClient> {
        const existing = this.instances.get(userId);
        if (existing) return existing;

        const lastFailure = this.connectFailures.get(userId) ?? 0;
        if (Date.now() - lastFailure < RETRY_COOLDOWN_MS) {
            throw new Error(
                `Broker unavailable for user ${userId} (cooling down after a recent connect failure)`
            );
        }

        const broker = await this.createBroker(userId);
        try {
            await broker.connect();
            this.instances.set(userId, broker);
            this.connectFailures.delete(userId);
            return broker;
        } catch (err) {
            logger.error({ err, userId }, "Failed to connect user broker instance — not caching");
            this.connectFailures.set(userId, Date.now());
            throw err;
        }
    }

    clearBroker(userId: string): void {
        this.instances.delete(userId);
    }

    private async createBroker(userId: string): Promise<BrokerClient> {
        if (env.paperTrading) {
            logger.debug({ userId }, "PAPER_TRADING enabled — creating PaperBroker for user");
            return new PaperBroker(this.priceLookup);
        }

        if (env.brokerProvider === "zerodha") {
            const tokenData = this.tokenRepo.getZerodhaToken(userId);
            return new ZerodhaBroker(
                {
                    apiKey: env.brokerApiKey,
                    apiSecret: env.brokerApiSecret,
                    accessToken: tokenData?.accessToken || (userId === "SYSTEM_DEFAULT" ? env.brokerAccessToken || process.env.ZERODHA_ACCESS_TOKEN : undefined),
                    requestToken: env.brokerRequestToken,
                    defaultExchange: env.brokerDefaultExchange,
                    product: env.brokerProduct,
                },
                { tokenRepo: this.tokenRepo }
            );
        }

        if (env.brokerProvider === "angelone") {
            // AngelOneBroker retrieves credentials mostly from env right now.
            // If we go completely multi-tenant, AngelOne credentials need to be stored in DB per user.
            const tokenData = this.tokenRepo.getAngelOneToken(userId);
            const broker = new AngelOneBroker({
                apiKey: env.angelOneApiKey,
                clientId: tokenData?.clientId || env.angelOneClientId,
                password: env.angelOnePassword,
                totpSecret: env.angelOneTotpSecret,
                defaultExchange: env.angelOneDefaultExchange,
                productType: env.angelOneProductType,
            });
            return broker;
        }

        return new PaperBroker(this.priceLookup);
    }
}
