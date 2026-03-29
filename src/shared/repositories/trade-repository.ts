/**
 * TradeRepository — trading book positions (open and closed).
 */
import type Database from 'better-sqlite3';
import type { ClosedTradeInput, OpenTradeInput } from '../analytics/trading';

export interface ClosedTradeRecord extends ClosedTradeInput {
  symbol: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
}

export interface OpenTradeRecord {
  symbol: string;
  shares: number;
  entryPrice: number;
  entryDate: string;
  stopPrice: number | null;
  timeLimitDays: number;
  daysHeld: number;
  currentPrice: number | null;
}

export class TradeRepository {
  constructor(private db: Database.Database) {}

  getClosedTrades(): ClosedTradeRecord[] {
    const rows = this.db.prepare(`
      SELECT symbol, shares, entry_price, exit_price, entry_date, exit_date, pnl,
        CAST(julianday(exit_date) - julianday(entry_date) AS INTEGER) as hold_days
      FROM trading_positions
      WHERE status = 'closed'
      ORDER BY exit_date DESC
    `).all() as {
      symbol: string; shares: number; entry_price: number; exit_price: number;
      entry_date: string; exit_date: string; pnl: number; hold_days: number;
    }[];

    return rows.map(r => ({
      symbol: r.symbol,
      shares: r.shares,
      entryPrice: r.entry_price,
      exitPrice: r.exit_price,
      entryDate: r.entry_date,
      exitDate: r.exit_date,
      realizedGain: r.pnl,
      realizedGainPct: r.entry_price > 0 ? ((r.exit_price - r.entry_price) / r.entry_price) * 100 : 0,
      holdDays: r.hold_days,
      isWin: r.pnl > 0,
    }));
  }

  getOpenTrades(): OpenTradeRecord[] {
    const rows = this.db.prepare(`
      SELECT tp.symbol, tp.shares, tp.entry_price, tp.entry_date, tp.stop_price,
        tp.time_limit_days,
        CAST(julianday('now') - julianday(tp.entry_date) AS INTEGER) as days_held,
        (SELECT ph.close_price FROM price_history ph
         JOIN securities s ON ph.security_id = s.id
         WHERE s.symbol = tp.symbol
         ORDER BY ph.date DESC LIMIT 1) as current_price
      FROM trading_positions tp
      WHERE tp.status = 'open'
    `).all() as {
      symbol: string; shares: number; entry_price: number; entry_date: string;
      stop_price: number | null; time_limit_days: number; days_held: number;
      current_price: number | null;
    }[];

    return rows.map(r => ({
      symbol: r.symbol,
      shares: r.shares,
      entryPrice: r.entry_price,
      entryDate: r.entry_date,
      stopPrice: r.stop_price,
      timeLimitDays: r.time_limit_days,
      daysHeld: r.days_held,
      currentPrice: r.current_price,
    }));
  }
}
