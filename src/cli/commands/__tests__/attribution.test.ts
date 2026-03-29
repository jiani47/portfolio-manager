import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedPortfolio } from '../../../shared/repositories/__tests__/fixture';
import { run } from '../attribution';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  seedPortfolio(db);

  const now = '2026-03-27T00:00:00Z';

  // Add QQQ as benchmark
  db.exec(`INSERT INTO securities (id, symbol, name, type, created_at) VALUES ('sec-qqq', 'QQQ', 'Invesco QQQ', 'etf', '${now}')`);

  // 30 days of price history for portfolio + QQQ
  for (let i = 0; i < 30; i++) {
    const date = `2026-03-${String(i + 1).padStart(2, '0')}`;
    const googPrice = 270 + i * 0.33;  // +10 over 30 days
    const nvdaPrice = 145 + i * 0.17;  // +5 over 30 days
    const sofiPrice = 11.5 + i * 0.017; // +0.5 over 30 days
    const qqqPrice = 450 + i * 0.5;    // +15 over 30 days

    db.exec(`INSERT OR REPLACE INTO price_history (id, security_id, date, close_price, fetched_at) VALUES
      ('ph-goog-${i}', 'sec-goog', '${date}', ${googPrice}, '${now}'),
      ('ph-nvda-${i}', 'sec-nvda', '${date}', ${nvdaPrice}, '${now}'),
      ('ph-sofi-${i}', 'sec-sofi', '${date}', ${sofiPrice}, '${now}'),
      ('ph-qqq-${i}', 'sec-qqq', '${date}', ${qqqPrice}, '${now}')`);
  }
});

describe('attribution CLI command', () => {
  it('returns decomposition with beta, sector, and selection effects', () => {
    const result = run(['30'], db);

    expect(result.decomposition).toBeDefined();
    expect(typeof result.decomposition.betaEffect).toBe('number');
    expect(typeof result.decomposition.sectorAllocation).toBe('number');
    expect(typeof result.decomposition.stockSelection).toBe('number');
  });

  it('gap equals sum of components', () => {
    const result = run(['30'], db);
    const d = result.decomposition;

    expect(d.betaEffect + d.sectorAllocation + d.stockSelection).toBeCloseTo(d.gap, 6);
  });

  it('returns per-position contributions', () => {
    const result = run(['30'], db);

    expect(result.positionContributions.length).toBeGreaterThan(0);
    for (const pc of result.positionContributions) {
      expect(pc.symbol).toBeDefined();
      expect(typeof pc.contribution).toBe('number');
    }
  });

  it('defaults to 90 days when no arg', () => {
    // Should not throw even with limited data
    const result = run([], db);
    expect(result.decomposition).toBeDefined();
  });
});
