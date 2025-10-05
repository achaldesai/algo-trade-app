import logger from "../utils/logger";
import type { EnvConfig } from "./env";

const SUPPORTED_BROKERS = new Set(["paper", "zerodha"]);
const SUPPORTED_EXCHANGES = new Set(["NSE", "BSE", "NFO", "BFO", "CDS", "MCX", "BCD"]);
const SUPPORTED_PRODUCTS = new Set(["CNC", "MIS", "NRML"]);

export const validateEnvironment = (env: EnvConfig): void => {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!SUPPORTED_BROKERS.has(env.brokerProvider)) {
    warnings.push(`Unsupported broker provider '${env.brokerProvider}'. Falling back to paper broker.`);
  }

  if (env.brokerProvider === "zerodha") {
    if (!env.brokerApiKey) {
      errors.push("Zerodha broker selected but BROKER_API_KEY is missing.");
    }

    const hasAccessToken = env.brokerAccessToken.trim().length > 0;
    const hasRequestFlow = env.brokerRequestToken.trim().length > 0 && env.brokerApiSecret.trim().length > 0;

    if (!hasAccessToken && !hasRequestFlow) {
      warnings.push("Zerodha broker will operate in paper mode because BROKER_ACCESS_TOKEN or (BROKER_REQUEST_TOKEN + BROKER_API_SECRET) are not set.");
    }

    if (!SUPPORTED_EXCHANGES.has(env.brokerDefaultExchange.toUpperCase())) {
      warnings.push(`BROKER_DEFAULT_EXCHANGE '${env.brokerDefaultExchange}' is not recognised by Kite Connect.`);
    }

    if (!SUPPORTED_PRODUCTS.has(env.brokerProduct.toUpperCase())) {
      warnings.push(`BROKER_PRODUCT '${env.brokerProduct}' is not in {${Array.from(SUPPORTED_PRODUCTS).join(", ")}}.`);
    }
  }

  warnings.forEach((message) => {
    logger.warn({ message }, "Environment validation warning");
  });

  errors.forEach((message) => {
    logger.error({ message }, "Environment validation error");
  });

  if (!warnings.length && !errors.length) {
    logger.info("Environment validation completed successfully");
  }
};

export default validateEnvironment;
