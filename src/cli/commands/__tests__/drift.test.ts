import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedPortfolio } from '../../../shared/repositories/__tests__/fixture';
import { run } from '../drift';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  seedPortfolio(db);
});

describe('drift CLI command', () => {
  it('returns allocation rows with drift for all positions', () => {
    const result = run([], db);

    // Seeded: GOOG (150 shares × $280), NVDA (80 × $150), SOFI (500 × $12), cash $15k
    // Total = 42000 + 12000 + 6000 + 15000 = $75,000
    expect(result.length).toBeGreaterThanOrEqual(4); // GOOG, NVDA, SOFI, Cash
  });

  it('aggregates GOOG across both accounts', () => {
    const result = run([], db);
    const googRows = result.filter(r => r.symbol === 'GOOG');

    // Should be one merged row, not two
    expect(googRows).toHaveLength(1);
    // 150 shares × $280 = $42,000
    expect(googRows[0].marketValue).toBe(42000);
  });

  it('computes drift from target allocation', () => {
    const result = run([], db);
    const goog = result.find(r => r.symbol === 'GOOG')!;

    // GOOG target = 15%, current = 42000/75000 = 56%
    expect(goog.targetPct).toBe(15);
    expect(goog.driftPct).toBeCloseTo(56 - 15, 0);
  });

  it('includes cash row with implied target', () => {
    const result = run([], db);
    const cash = result.find(r => r.symbol === 'Cash')!;

    expect(cash).toBeDefined();
    expect(cash.marketValue).toBe(15000);
    // Assigned targets: 15 + 10 + 8 = 33%. Cash target = 67%
    expect(cash.targetPct).toBeCloseTo(67, 0);
  });

  it('returns empty portfolio gracefully', () => {
    db.exec('DELETE FROM position_intents; DELETE FROM positions;');
    const result = run([], db);

    // Just the Cash row with $0
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe('Cash');
  });
});
