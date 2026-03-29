import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../shared/repositories/__tests__/fixture';
import { run } from '../trade-stats';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();

  db.exec(`
    CREATE TABLE trading_positions (
      id TEXT PRIMARY KEY, security_id TEXT, symbol TEXT NOT NULL,
      entry_date TEXT NOT NULL, entry_price REAL NOT NULL, shares INTEGER NOT NULL,
      thesis TEXT NOT NULL, stop_price REAL, time_limit_days INTEGER NOT NULL DEFAULT 20,
      status TEXT NOT NULL DEFAULT 'open', exit_date TEXT, exit_price REAL,
      exit_reason TEXT, pnl REAL
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

    INSERT INTO trading_positions (id, symbol, entry_date, entry_price, shares, thesis, stop_price, status, exit_date, exit_price, exit_reason, pnl) VALUES
    ('tp-1', 'AAPL', '2026-03-01', 240, 10, 'bounce', 230, 'closed', '2026-03-10', 260, 'target hit', 200),
    ('tp-2', 'TSLA', '2026-03-05', 200, 5, 'breakout', 190, 'closed', '2026-03-15', 180, 'stop hit', -100),
    ('tp-3', 'AAPL', '2026-03-10', 250, 10, 'gap fill', 240, 'closed', '2026-03-20', 270, 'target hit', 200),
    ('tp-4', 'AAPL', '2026-03-20', 245, 8, 'retest', 235, 'open', NULL, NULL, NULL, NULL);
  `);
});

describe('trade-stats CLI command', () => {
  it('returns stats from closed trades', () => {
    const result = run([], db);

    expect(result.stats.totalTrades).toBe(3);
    expect(result.stats.wins).toBe(2);
    expect(result.stats.losses).toBe(1);
    expect(result.stats.winRate).toBeCloseTo(66.7, 0);
    expect(result.stats.totalRealizedGain).toBe(300); // 200 - 100 + 200
  });

  it('returns profit factor', () => {
    const result = run([], db);
    // grossWins = 400, grossLosses = 100
    expect(result.stats.profitFactor).toBeCloseTo(4.0, 1);
  });

  it('returns open trades with unrealized gain', () => {
    const result = run([], db);

    expect(result.openTrades).toHaveLength(1);
    expect(result.openTrades[0].symbol).toBe('AAPL');
    // 8 shares × (250 - 245) = $40
    expect(result.openTrades[0].unrealizedGain).toBe(40);
  });

  it('returns closed trades with exit reason', () => {
    const result = run([], db);

    expect(result.closedTrades).toHaveLength(3);
    // most recent first (exit_date DESC)
    expect(result.closedTrades[0].exitReason).toBe('target hit');
    expect(result.closedTrades[1].exitReason).toBe('stop hit');
  });

  it('handles no trades', () => {
    db.exec('DELETE FROM trading_positions');
    const result = run([], db);

    expect(result.stats.totalTrades).toBe(0);
    expect(result.openTrades).toHaveLength(0);
    expect(result.closedTrades).toHaveLength(0);
  });
});
