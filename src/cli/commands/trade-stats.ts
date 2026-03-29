/**
 * CLI trade-stats command — win rate, R/R, profit factor, open P&L.
 */
import type Database from 'better-sqlite3';
import { TradeRepository } from '../../shared/repositories/trade-repository';
import {
  calculateTradeStats,
  type TradeStatsResult,
} from '../../shared/analytics/trading';

export interface TradeStatsCommandResult {
  stats: TradeStatsResult;
  openTrades: Array<{
    symbol: string;
    shares: number;
    entryPrice: number;
    currentPrice: number | null;
    stopPrice: number | null;
    daysHeld: number;
    timeLimitDays: number;
    unrealizedGain: number | null;
    unrealizedGainPct: number | null;
  }>;
  closedTrades: Array<{
    symbol: string;
    shares: number;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    pnlPct: number;
    holdDays: number;
    exitReason: string;
  }>;
}

export function run(_args: string[], db: Database.Database): TradeStatsCommandResult {
  const repo = new TradeRepository(db);

  const closed = repo.getClosedTrades();
  const stats = calculateTradeStats(closed);

  const open = repo.getOpenTrades();

  const openTrades = open.map(t => {
    const unrealizedGain =
      t.currentPrice != null ? (t.currentPrice - t.entryPrice) * t.shares : null;
    const unrealizedGainPct =
      t.currentPrice != null && t.entryPrice > 0
        ? ((t.currentPrice - t.entryPrice) / t.entryPrice) * 100
        : null;
    return {
      symbol: t.symbol,
      shares: t.shares,
      entryPrice: t.entryPrice,
      currentPrice: t.currentPrice,
      stopPrice: t.stopPrice,
      daysHeld: t.daysHeld,
      timeLimitDays: t.timeLimitDays,
      unrealizedGain,
      unrealizedGainPct,
    };
  });

  const closedTrades = closed.map(t => ({
    symbol: t.symbol,
    shares: t.shares,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    pnl: t.realizedGain,
    pnlPct: t.realizedGainPct,
    holdDays: t.holdDays,
    exitReason: t.exitReason,
  }));

  return { stats, openTrades, closedTrades };
}
