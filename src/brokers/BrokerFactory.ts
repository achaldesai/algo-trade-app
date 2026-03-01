import type BrokerClient from "./BrokerClient";
import ZerodhaBroker from "./ZerodhaBroker";
import AngelOneBroker from "./AngelOneBroker";
import PaperBroker from "./PaperBroker";
import env from "../config/env";
import { getTokenRepository } from "../persistence/TokenRepository";
import logger from "../utils/logger";

export class BrokerFactory {
    private static instances = new Map<string, BrokerClient>();

    static async getBroker(userId: string): Promise<BrokerClient> {
        if (this.instances.has(userId)) {
            return this.instances.get(userId)!;
        }

        const broker = await this.createBroker(userId);
        try {
            await broker.connect();
        } catch (err) {
            logger.error({ err, userId }, "Failed to connect user broker instance");
        }
        this.instances.set(userId, broker);
        return broker;
    }

    static clearBroker(userId: string): void {
        this.instances.delete(userId);
    }

    private static async createBroker(userId: string): Promise<BrokerClient> {
        const tokenRepo = getTokenRepository(env.portfolioStorePath);

        if (env.brokerProvider === "zerodha") {
            const tokenData = await tokenRepo.getZerodhaToken(userId);
            return new ZerodhaBroker({
                apiKey: env.brokerApiKey,
                apiSecret: env.brokerApiSecret,
                accessToken: tokenData?.accessToken || (userId === "SYSTEM_DEFAULT" ? env.brokerAccessToken || process.env.ZERODHA_ACCESS_TOKEN : undefined),
                requestToken: env.brokerRequestToken,
                defaultExchange: env.brokerDefaultExchange,
                product: env.brokerProduct,
            });
        }

        if (env.brokerProvider === "angelone") {
            // AngelOneBroker retrieves credentials mostly from env right now.
            // If we go completely multi-tenant, AngelOne credentials need to be stored in DB per user.
            const tokenData = await tokenRepo.getAngelOneToken(userId);
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

        return new PaperBroker();
    }
}
