/**
 * Database layer barrel export.
 *
 * Usage:
 *   import { DatabaseManager, PortfolioRepo, SettingsRepo, ... } from "./db";
 */
export { DatabaseManager } from "./DatabaseManager";
export type {
    DatabaseHandles,
    TransactionContext,
    StockRecord,
    TradeRecord,
    RiskLimitsRecord,
    StopLossRecord,
    AuditLogRecord,
    ZerodhaTokenRecord,
    AngelOneTokenRecord,
    TokenRecord,
    UserRecord,
    StrategyConfigRecord,
} from "./DatabaseManager";

export { PortfolioRepo } from "./repositories/PortfolioRepo";
export type { CreateStockInput, CreateTradeInput } from "./repositories/PortfolioRepo";

export { SettingsRepo } from "./repositories/SettingsRepo";
export type { RiskLimits } from "./repositories/SettingsRepo";

export { StopLossRepo } from "./repositories/StopLossRepo";
export type { StopLossConfig, StopLossType } from "./repositories/StopLossRepo";

export { AuditLogRepo } from "./repositories/AuditLogRepo";

export { TokenRepo } from "./repositories/TokenRepo";

export { UserRepo } from "./repositories/UserRepo";

export { StrategyConfigRepo } from "./repositories/StrategyConfigRepo";
export type { UserStrategyConfig } from "./repositories/StrategyConfigRepo";

export { RepositoryConflictError } from "./repositories/errors";
export { deterministicTradeId } from "./repositories/storeUtils";
