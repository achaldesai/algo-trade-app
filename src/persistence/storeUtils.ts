import { createHash } from "node:crypto";
import type { CreateTradeRecord } from "./PortfolioRepository";

export const deterministicTradeId = (record: Omit<CreateTradeRecord, "id">): string => {
  const seedKey = `${record.symbol}-${record.side}-${record.executedAt.toISOString()}-${record.price}-${record.quantity}-${record.notes ?? ""}`;
  const hash = createHash("sha1").update(seedKey).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
};

export default deterministicTradeId;
