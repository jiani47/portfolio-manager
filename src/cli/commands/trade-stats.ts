/**
 * CLI trade-stats command — win rate, R/R, profit factor, open P&L.
 */
import type Database from 'better-sqlite3';
import { TradeRepository } from '../../shared/repositories/trade-repository';
import {
  calculateTradeStats,
  calculateOpenPnl,
  type TradeStatsResult,
  type OpenPnlResult,
} from '../../shared/analytics/trading';

export interface TradeStatsCommandResult {
  stats: TradeStatsResult;
  openPnl: OpenPnlResult[];
}

export function run(_args: string[], db: Database.Database): TradeStatsCommandResult {
  const repo = new TradeRepository(db);

  const closed = repo.getClosedTrades();
  const stats = calculateTradeStats(closed);

  const open = repo.getOpenTrades();
  const openPnl = calculateOpenPnl(
    open.map(t => ({
      shares: t.shares,
      entryPrice: t.entryPrice,
      currentPrice: t.currentPrice,
    })),
  );

  return { stats, openPnl };
}
