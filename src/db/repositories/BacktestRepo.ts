import type DatabaseManager from "../DatabaseManager";
import type { BacktestRecord } from "../DatabaseManager";
import type { BacktestRun, BacktestSummary } from "../../services/BacktestService";

export const MAX_RUNS_PER_USER = 50;

/**
 * Saved backtest runs, one LMDB entry per run.
 *
 * Key format: `{userId}:{runId}`. Run ids start with a base-36 timestamp, so a
 * user's runs sort oldest → newest within their key range.
 */
export class BacktestRepo {
  constructor(private readonly db: DatabaseManager) {}

  private range(userId: string) {
    return this.db.handles.backtests.getRange({ start: `${userId}:`, end: `${userId}:￿` });
  }

  /** Save a run and trim the user's history to the newest MAX_RUNS_PER_USER. */
  async save(run: BacktestRun): Promise<void> {
    const { backtests } = this.db.handles;
    await backtests.put(`${run.userId}:${run.id}`, run as unknown as BacktestRecord);

    const keys = [...this.range(run.userId)].map(({ key }) => key);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_RUNS_PER_USER))) {
      await backtests.remove(key);
    }
  }

  /** Newest first, without the equity curve and trade list. */
  list(userId: string): BacktestSummary[] {
    return [...this.range(userId)]
      .map(({ value }) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { equityCurve, trades, rejections, ...summary } = value as unknown as BacktestRun;
        return summary;
      })
      .reverse();
  }

  get(userId: string, id: string): BacktestRun | undefined {
    return this.db.handles.backtests.get(`${userId}:${id}`) as unknown as BacktestRun | undefined;
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const key = `${userId}:${id}`;
    if (!this.db.handles.backtests.get(key)) return false;
    await this.db.handles.backtests.remove(key);
    return true;
  }
}

export default BacktestRepo;
