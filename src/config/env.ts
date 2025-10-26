import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

const parsePort = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const DEFAULT_DATA_FILE = path.resolve(process.cwd(), "data/portfolio-store.json");
const DEFAULT_DATA_DIRECTORY = path.resolve(process.cwd(), "data/portfolio-store");

const parsePortfolioStore = (
  backendRaw: string | undefined,
  storeRaw: string | undefined,
): { backend: "file" | "lmdb"; path: string } => {
  const resolvedStore = storeRaw ? path.resolve(process.cwd(), storeRaw) : undefined;
  const normalizedBackend = backendRaw?.trim().toLowerCase();

  let backend: "file" | "lmdb";

  if (normalizedBackend === "file" || normalizedBackend === "lmdb") {
    backend = normalizedBackend;
  } else if (resolvedStore?.endsWith(".json")) {
    backend = "file";
  } else {
    backend = "lmdb";
  }

  const pathForBackend = resolvedStore ?? (backend === "file" ? DEFAULT_DATA_FILE : DEFAULT_DATA_DIRECTORY);

  return {
    backend,
    path: pathForBackend,
  };
};

const portfolioStore = parsePortfolioStore(process.env.PORTFOLIO_BACKEND, process.env.PORTFOLIO_STORE);

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parsePort(process.env.PORT, 3000),
  brokerProvider: (process.env.BROKER_PROVIDER ?? "paper").toLowerCase(),
  brokerBaseUrl: process.env.BROKER_BASE_URL ?? "",

  // Legacy Zerodha/KiteConnect configuration
  brokerApiKey: process.env.BROKER_API_KEY ?? "eac2wbs798o3cl7t",
  brokerApiSecret: process.env.BROKER_API_SECRET ?? "nnyzg2a9x2ffp4d8kzm06xvtkgxt3vfw",
  brokerAccessToken: process.env.BROKER_ACCESS_TOKEN ?? "",
  brokerRequestToken: process.env.BROKER_REQUEST_TOKEN ?? "",
  brokerDefaultExchange: process.env.BROKER_DEFAULT_EXCHANGE ?? "NSE",
  brokerProduct: process.env.BROKER_PRODUCT ?? "CNC",

  // Angel One SmartAPI configuration
  angelOneApiKey: process.env.ANGEL_ONE_API_KEY ?? "",
  angelOneClientId: process.env.ANGEL_ONE_CLIENT_ID ?? "",
  angelOnePassword: process.env.ANGEL_ONE_PASSWORD ?? "",
  angelOneTotpSecret: process.env.ANGEL_ONE_TOTP_SECRET ?? "",
  angelOneDefaultExchange: process.env.ANGEL_ONE_DEFAULT_EXCHANGE ?? "NSE",
  angelOneProductType: process.env.ANGEL_ONE_PRODUCT_TYPE ?? "DELIVERY",

  portfolioBackend: portfolioStore.backend,
  portfolioStorePath: portfolioStore.path,
  dryRun: process.env.DRY_RUN === "true",
  maxPositionSize: parsePort(process.env.MAX_POSITION_SIZE, 100000),
  enableNotifications: process.env.ENABLE_NOTIFICATIONS === "true",
  adminApiKey: process.env.ADMIN_API_KEY ?? "",
};

export type EnvConfig = typeof env;

export default env;
