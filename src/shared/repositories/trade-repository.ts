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
  exitReason: string;
  stopPrice: number | null;
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
    // Note: closed trades are positions with quantity=0 in trading book
    // Exit data comes from tax_lots and decision_logs
    const rows = this.db.prepare(`
      SELECT s.symbol,
        tl.quantity as shares,
        tl.cost_per_share as entry_price,
        (tl.realized_gain / tl.quantity + tl.cost_per_share) as exit_price,
        tl.acquisition_date as entry_date,
        tl.closed_date as exit_date,
        tl.realized_gain as pnl,
        CAST(julianday(tl.closed_date) - julianday(tl.acquisition_date) AS INTEGER) as hold_days,
        p.stop_price,
        (SELECT dl.decision FROM decision_logs dl
         WHERE dl.security_id = s.id AND dl.decision_type = 'trade-exit'
         ORDER BY dl.decision_date DESC LIMIT 1) as exit_reason
      FROM tax_lots tl
      JOIN accounts a ON tl.account_id = a.id
      JOIN securities s ON tl.security_id = s.id
      JOIN positions p ON p.account_id = tl.account_id AND p.security_id = tl.security_id
      WHERE a.book = 'trading' AND tl.is_open = 0
      ORDER BY tl.closed_date DESC
    `).all() as {
      symbol: string; shares: number; entry_price: number; exit_price: number;
      entry_date: string; exit_date: string; pnl: number; hold_days: number;
      exit_reason: string | null; stop_price: number | null;
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
      exitReason: r.exit_reason || '',
      stopPrice: r.stop_price,
    }));
  }

  getOpenTrades(): OpenTradeRecord[] {
    const rows = this.db.prepare(`
      SELECT s.symbol, p.quantity as shares,
        CASE WHEN p.quantity > 0 THEN p.cost_basis / p.quantity ELSE 0 END as entry_price,
        substr(p.last_updated, 1, 10) as entry_date,
        p.stop_price, p.time_limit_days,
        CAST(julianday('now') - julianday(p.last_updated) AS INTEGER) as days_held,
        (SELECT ph.close_price FROM price_history ph
         WHERE ph.security_id = p.security_id
         ORDER BY ph.date DESC LIMIT 1) as current_price
      FROM positions p
      JOIN accounts a ON p.account_id = a.id
      JOIN securities s ON p.security_id = s.id
      WHERE a.book = 'trading' AND p.quantity > 0
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
      timeLimitDays: r.time_limit_days || 20, // default if not set
      daysHeld: r.days_held,
      currentPrice: r.current_price,
    }));
  }
}
