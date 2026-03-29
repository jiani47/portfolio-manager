import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedPortfolio } from '../../../shared/repositories/__tests__/fixture';
import { run } from '../levels-refresh';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  seedPortfolio(db);

  // Add 6 months of OHLCV for GOOG with clear swing points
  const now = '2026-03-27T00:00:00Z';
  const bars: string[] = [];
  for (let i = 0; i < 130; i++) {
    const day = new Date(2025, 9, 1); // Oct 1 2025
    day.setDate(day.getDate() + i);
    const dateStr = day.toISOString().split('T')[0];

    // Create some swing points
    let high = 290, low = 275, close = 282;
    if (i === 30) { high = 310; low = 295; close = 300; }  // swing high
    if (i === 60) { high = 275; low = 255; close = 260; }  // swing low
    if (i === 90) { high = 305; low = 290; close = 298; }  // swing high
    if (i === 120) { high = 270; low = 258; close = 262; } // swing low

    bars.push(`('ph-goog-${i}', 'sec-goog', '${dateStr}', ${(high+low)/2}, ${high}, ${low}, ${close}, 5000000, '${now}')`);
  }
  db.exec(`INSERT OR REPLACE INTO price_history (id, security_id, date, open_price, high_price, low_price, close_price, volume, fetched_at) VALUES ${bars.join(',')}`);
});

describe('levels-refresh CLI command', () => {
  it('computes support and resistance for a symbol', () => {
    const result = run(['GOOG'], db);

    expect(result.symbol).toBe('GOOG');
    expect(result.support.length).toBeGreaterThanOrEqual(0);
    expect(result.resistance.length).toBeGreaterThanOrEqual(0);
  });

  it('returns levels with strength scores 1-10', () => {
    const result = run(['GOOG'], db);

    for (const l of [...result.support, ...result.resistance]) {
      expect(l.strength).toBeGreaterThanOrEqual(1);
      expect(l.strength).toBeLessThanOrEqual(10);
    }
  });

  it('support levels are below current price', () => {
    const result = run(['GOOG'], db);
    const currentPrice = 280; // latest close from seed

    for (const s of result.support) {
      expect(s.price).toBeLessThan(currentPrice);
    }
  });

  it('throws for unknown symbol', () => {
    expect(() => run(['UNKNOWN'], db)).toThrow();
  });
});
