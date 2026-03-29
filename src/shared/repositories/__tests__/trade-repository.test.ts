import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './fixture';
import { TradeRepository } from '../trade-repository';

let db: Database.Database;
let repo: TradeRepository;

beforeEach(() => {
  db = createTestDb();

  // Add trading_positions table (not in base fixture since it's trading-specific)
  db.exec(`
    CREATE TABLE trading_positions (
      id TEXT PRIMARY KEY,
      security_id TEXT,
      symbol TEXT NOT NULL,
      entry_date TEXT NOT NULL,
      entry_price REAL NOT NULL,
      shares INTEGER NOT NULL,
      thesis TEXT NOT NULL,
      stop_price REAL,
      time_limit_days INTEGER NOT NULL DEFAULT 20,
      status TEXT NOT NULL DEFAULT 'open',
      exit_date TEXT,
      exit_price REAL,
      exit_reason TEXT,
      pnl REAL
    );
  `);

  const now = '2026-03-27T00:00:00Z';
  db.exec(`
    INSERT INTO securities (id, symbol, name, type, created_at) VALUES
    ('sec-aapl', 'AAPL', 'Apple', 'stock', '${now}'),
    ('sec-tsla', 'TSLA', 'Tesla', 'stock', '${now}');

    INSERT INTO price_history (id, security_id, date, close_price, fetched_at) VALUES
    ('ph-aapl', 'sec-aapl', '2026-03-27', 250.00, '${now}'),
    ('ph-tsla', 'sec-tsla', '2026-03-27', 180.00, '${now}');

    INSERT INTO trading_positions (id, symbol, entry_date, entry_price, shares, thesis, stop_price, status, exit_date, exit_price, pnl) VALUES
    ('tp-1', 'AAPL', '2026-03-01', 240, 10, 'bounce', 230, 'closed', '2026-03-10', 260, 200),
    ('tp-2', 'TSLA', '2026-03-05', 200, 5, 'breakout', 190, 'closed', '2026-03-15', 180, -100),
    ('tp-3', 'AAPL', '2026-03-20', 245, 8, 'retest', 235, 'open', NULL, NULL, NULL);
  `);

  repo = new TradeRepository(db);
});

describe('TradeRepository', () => {
  describe('getClosedTrades', () => {
    it('returns closed trades with hold days', () => {
      const trades = repo.getClosedTrades();

      expect(trades).toHaveLength(2);
      // Ordered by exit_date DESC: TSLA (Mar 15) then AAPL (Mar 10)
      const aapl = trades.find(t => t.symbol === 'AAPL')!;
      expect(aapl.realizedGain).toBe(200);
      expect(aapl.isWin).toBe(true);
      expect(aapl.holdDays).toBe(9); // Mar 1→10
    });

    it('marks losses correctly', () => {
      const trades = repo.getClosedTrades();
      const tsla = trades.find(t => t.symbol === 'TSLA')!;

      expect(tsla.isWin).toBe(false);
      expect(tsla.realizedGain).toBe(-100);
    });
  });

  describe('getOpenTrades', () => {
    it('returns open trades with current price', () => {
      const trades = repo.getOpenTrades();

      expect(trades).toHaveLength(1);
      expect(trades[0].symbol).toBe('AAPL');
      expect(trades[0].currentPrice).toBe(250);
      expect(trades[0].shares).toBe(8);
      expect(trades[0].entryPrice).toBe(245);
    });
  });
});
