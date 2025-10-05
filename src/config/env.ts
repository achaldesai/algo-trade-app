import dotenv from "dotenv";

dotenv.config();

const parsePort = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parsePort(process.env.PORT, 3000),
  enableRequestLogging: (process.env.REQUEST_LOGGING ?? "false").toLowerCase() === "true",
  brokerProvider: (process.env.BROKER_PROVIDER ?? "paper").toLowerCase(),
  brokerBaseUrl: process.env.BROKER_BASE_URL ?? "",
  brokerApiKey: process.env.BROKER_API_KEY ?? "",
};

export default env;
