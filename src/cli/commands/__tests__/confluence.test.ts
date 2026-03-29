import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedPortfolio } from '../../../shared/repositories/__tests__/fixture';
import { run as runConfluence } from '../confluence';
import { run as runScreen } from '../screen';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  seedPortfolio(db);

  const now = '2026-03-27T00:00:00Z';

  // GOOG: FAIR PEG + strong growth + near support → 3 signals
  db.exec(`
    INSERT INTO valuation_metrics (id, symbol, date, forward_peg, peg_rating, eps_growth_pct, forward_pe, forward_eps, fetched_at) VALUES
    ('vm-goog', 'GOOG', '2026-03-27', 0.9, 'FAIR', 25.0, 20.0, 14.0, '${now}'),
    ('vm-nvda', 'NVDA', '2026-03-27', 1.8, 'RICH', 40.0, 35.0, 4.29, '${now}'),
    ('vm-sofi', 'SOFI', '2026-03-27', 0.6, 'CHEAP', 55.0, 15.0, 0.80, '${now}');
  `);

  // Support near current price for GOOG ($280, support at $270 = 3.6% away)
  db.exec(`
    INSERT INTO price_levels (id, symbol, level_type, price, strength, source, created_at, updated_at) VALUES
    ('pl-goog-s', 'GOOG', 'support', 270.00, 7, 'swing', '${now}', '${now}'),
    ('pl-sofi-s', 'SOFI', 'support', 11.50, 5, 'swing', '${now}', '${now}'),
    ('pl-sofi-r', 'SOFI', 'resistance', 12.50, 6, 'swing', '${now}', '${now}');
  `);
});

describe('confluence CLI command', () => {
  it('detects confluence for symbols with 2+ signals', () => {
    const result = runConfluence([], db);

    // GOOG: FAIR + growth(25%) + near support → 3 signals
    const goog = result.find(r => r.symbol === 'GOOG');
    expect(goog).toBeDefined();
    expect(goog!.hasConfluence).toBe(true);
    expect(goog!.signalCount).toBe(3);
  });

  it('excludes symbols with only 1 signal', () => {
    const result = runConfluence([], db);

    // NVDA: RICH PEG (no val signal) + growth only → 1 signal
    const nvda = result.find(r => r.symbol === 'NVDA');
    expect(nvda).toBeUndefined(); // filtered out
  });

  it('includes SOFI with 2+ signals', () => {
    const result = runConfluence([], db);

    // SOFI: CHEAP + growth(55%) + near support ($11.50 vs $12 = 4.2%) → 3 signals
    const sofi = result.find(r => r.symbol === 'SOFI');
    expect(sofi).toBeDefined();
    expect(sofi!.hasConfluence).toBe(true);
  });

  it('returns empty when no symbols have confluence', () => {
    db.exec('DELETE FROM valuation_metrics');
    const result = runConfluence([], db);
    expect(result).toHaveLength(0);
  });
});

describe('screen CLI command', () => {
  it('returns screening scores for all symbols with valuations', () => {
    const result = runScreen([], db);

    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('sorts by composite score descending', () => {
    const result = runScreen([], db);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].compositeScore).toBeLessThanOrEqual(result[i - 1].compositeScore);
    }
  });

  it('SOFI scores highest (CHEAP + near support + high growth)', () => {
    const result = runScreen([], db);
    // SOFI: val=3(CHEAP) + tech=1(near support) + growth=2(55%>50%) = 6
    expect(result[0].symbol).toBe('SOFI');
    expect(result[0].compositeScore).toBe(6);
  });

  it('includes valuation and growth scores per symbol', () => {
    const result = runScreen([], db);
    const goog = result.find(r => r.symbol === 'GOOG')!;

    expect(goog.valuationScore).toBe(2); // FAIR
    expect(goog.growthScore).toBe(0);    // 25% < 30% threshold
  });
});
