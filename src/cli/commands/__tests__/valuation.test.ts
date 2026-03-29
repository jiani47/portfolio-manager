import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedPortfolio } from '../../../shared/repositories/__tests__/fixture';
import { run } from '../valuation';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  seedPortfolio(db);

  const now = '2026-03-27T00:00:00Z';
  db.exec(`
    INSERT INTO valuation_metrics (id, symbol, date, trailing_pe, forward_pe, peg, forward_peg,
      trailing_eps, forward_eps, eps_growth_pct, fair_low, fair_mid, fair_high, peg_rating, fetched_at) VALUES
    ('vm-goog', 'GOOG', '2026-03-27', 22.0, 20.0, 1.1, 0.9,
      12.73, 14.0, 25.0, 240.0, 280.0, 320.0, 'FAIR', '${now}');
  `);
});

describe('valuation CLI command', () => {
  it('returns valuation metrics + computed fair range for a symbol', () => {
    const result = run(['GOOG'], db);

    expect(result.symbol).toBe('GOOG');
    expect(result.currentPrice).toBe(280);
    expect(result.metrics).toBeDefined();
    expect(result.metrics!.trailingPe).toBe(22);
    expect(result.metrics!.forwardPeg).toBe(0.9);
  });

  it('includes computed fair price range', () => {
    const result = run(['GOOG'], db);

    // fwd_eps=14, fwd_pe=20 (value stock), base=280
    // 85/100/115% → 238/280/322
    // PEG=1: 14 × 25 = 350 > 322 → high = 350
    expect(result.computedFairRange).not.toBeNull();
    expect(result.computedFairRange!.fairLow).toBeCloseTo(238, 0);
    expect(result.computedFairRange!.fairMid).toBeCloseTo(280, 0);
    expect(result.computedFairRange!.fairHigh).toBeCloseTo(350, 0);
  });

  it('includes PEG rating', () => {
    const result = run(['GOOG'], db);
    expect(result.computedPegRating).toBe('FAIR');
  });

  it('returns null metrics for symbol with no valuation data', () => {
    const result = run(['SOFI'], db);
    expect(result.metrics).toBeNull();
    expect(result.computedFairRange).toBeNull();
  });

  it('throws for unknown symbol', () => {
    expect(() => run(['UNKNOWN'], db)).toThrow();
  });
});
