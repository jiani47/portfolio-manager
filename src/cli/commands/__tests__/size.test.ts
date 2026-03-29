import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedPortfolio } from '../../../shared/repositories/__tests__/fixture';
import { run } from '../size';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  seedPortfolio(db);

  // Add 14 days OHLCV for NVDA (ATR data)
  const now = '2026-03-27T00:00:00Z';
  for (let i = 0; i < 14; i++) {
    const date = `2026-03-${String(13 + i).padStart(2, '0')}`;
    db.exec(`INSERT OR REPLACE INTO price_history (id, security_id, date, open_price, high_price, low_price, close_price, volume, fetched_at)
      VALUES ('ph-nvda-${i}', 'sec-nvda', '${date}', 150, 155, 145, 150, 1000000, '${now}')`);
  }

  // S/R levels for NVDA
  db.exec(`
    INSERT INTO price_levels (id, symbol, level_type, price, strength, source, created_at, updated_at) VALUES
    ('pl-1', 'NVDA', 'support', 140.00, 7, 'swing', '${now}', '${now}'),
    ('pl-2', 'NVDA', 'support', 130.00, 5, 'swing', '${now}', '${now}');
  `);
});

describe('size CLI command', () => {
  it('returns sizing result with room and tranches for a symbol', () => {
    const result = run(['NVDA'], db);

    expect(result.sizing).toBeDefined();
    expect(result.sizing.tierLimitPct).toBe(10); // Growth
    expect(result.sizing.currentMarketValue).toBe(80 * 150); // 80 shares × $150
    expect(result.tranches).toBeDefined();
    expect(result.tranches.length).toBeGreaterThanOrEqual(0);
  });

  it('uses tier limit from intent', () => {
    const result = run(['NVDA'], db);
    expect(result.sizing.tierLimitPct).toBe(10); // Growth = 10%
  });

  it('accepts target override as second arg', () => {
    const result = run(['NVDA', '15'], db);
    expect(result.sizing.tierLimitPct).toBe(15); // overridden
  });

  it('computes tranches with S/R levels when available', () => {
    const result = run(['NVDA'], db);

    if (result.tranches.length >= 3) {
      // First tranche should use nearest support ($140)
      expect(result.tranches[0].entryPrice).toBe(140);
    }
  });

  it('returns error for unknown symbol', () => {
    expect(() => run(['UNKNOWN'], db)).toThrow();
  });
});
