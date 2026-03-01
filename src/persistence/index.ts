import env from "../config/env";
import FilePortfolioRepository from "./FilePortfolioRepository";
import LmdbPortfolioRepository from "./LmdbPortfolioRepository";
import { LmdbSettingsRepository } from "./LmdbSettingsRepository";
import { LmdbStopLossRepository } from "./LmdbStopLossRepository";
import { LmdbAuditLogRepository } from "./LmdbAuditLogRepository";
import type PortfolioRepository from "./PortfolioRepository";
import type { SettingsRepository } from "./SettingsRepository";
import type { StopLossRepository } from "./StopLossRepository";
import type { AuditLogRepository } from "./AuditLogRepository";
import { getUserRepository as getLmdbUserRepository, type UserRepository } from "./UserRepository";

const repository: PortfolioRepository = env.portfolioBackend === "lmdb"
  ? new LmdbPortfolioRepository(env.portfolioStorePath)
  : new FilePortfolioRepository(env.portfolioStorePath);

const settingsRepository: SettingsRepository = new LmdbSettingsRepository(env.settingsStorePath);

const stopLossRepository: StopLossRepository = new LmdbStopLossRepository(env.stopLossStorePath);

const auditLogRepository: AuditLogRepository = new LmdbAuditLogRepository(env.auditLogStorePath);

const userStorePath = env.portfolioStorePath.endsWith('.json')
  ? env.portfolioStorePath.replace('.json', '_users.lmdb')
  : env.portfolioStorePath;

const userRepository: UserRepository = getLmdbUserRepository(userStorePath);

export const ensurePortfolioStore = async (): Promise<void> => {
  await repository.initialize();
};

export const ensureSettingsStore = async (): Promise<void> => {
  await settingsRepository.initialize();
};

export const ensureStopLossStore = async (): Promise<void> => {
  await stopLossRepository.initialize();
};

export const ensureAuditLogStore = async (): Promise<void> => {
  await auditLogRepository.initialize();
};

export const ensureUserStore = async (): Promise<void> => {
  await userRepository.initialize();
};

export const resetPortfolioStore = async (): Promise<void> => {
  await repository.reset();
};

export const getPortfolioRepository = (): PortfolioRepository => repository;
export const getSettingsRepository = (): SettingsRepository => settingsRepository;
export const getStopLossRepository = (): StopLossRepository => stopLossRepository;
export const getAuditLogRepository = (): AuditLogRepository => auditLogRepository;
export const getUserRepository = (): UserRepository => userRepository;

export default repository;
