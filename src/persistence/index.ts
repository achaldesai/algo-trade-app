import env from "../config/env";
import FilePortfolioRepository from "./FilePortfolioRepository";
import LmdbPortfolioRepository from "./LmdbPortfolioRepository";
import type PortfolioRepository from "./PortfolioRepository";

const repository: PortfolioRepository = env.portfolioBackend === "lmdb"
  ? new LmdbPortfolioRepository(env.portfolioStorePath)
  : new FilePortfolioRepository(env.portfolioStorePath);

export const ensurePortfolioStore = async (): Promise<void> => {
  await repository.initialize();
};

export const resetPortfolioStore = async (): Promise<void> => {
  await repository.reset();
};

export const getPortfolioRepository = (): PortfolioRepository => repository;

export default repository;
