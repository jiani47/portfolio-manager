import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedPortfolio, seedBasket } from '../../../shared/repositories/__tests__/fixture';
import { run } from '../basket-resize';

let db: Database.Database;

/**
 * Seeded portfolio (after seedBasket overrides):
 *   GOOG: 150 shares × $280 = $42,000
 *   NVDA:  80 shares × $150 = $12,000
 *   SOFI: 500 shares ×  $12 =  $6,000
 *   Cash: $15,000
 *   Total: $75,000
 *
 * NVDA buy plan: target 20% = $15,000 → 100 shares, has 80 → need 20
 *   6 tranches × 10 = 60 total → should resize to 20 (3+3+3+3+3+5)
 *
 * SOFI sell plan: target 4% = $3,000 → 250 shares, has 500 → sell 250
 *   2 tranches × 100 = 200 total → should resize to 250 (125+125)
 */

beforeEach(() => {
  db = createTestDb();
  seedPortfolio(db);
  seedBasket(db);
});

describe('basket-resize', () => {
  it('resizes buy tranches down when position has grown', () => {
    const result = run(['test-basket'], db);
    const nvda = result.resized.find(r => r.symbol === 'NVDA');

    expect(nvda).toBeDefined();
    expect(nvda!.action).toBe('resized');
    expect(nvda!.oldTotal).toBe(60);
    expect(nvda!.newTotal).toBe(20);
    expect(nvda!.targetPct).toBe(20);
    expect(nvda!.tranches.length).toBe(6);

    // Verify total distributed = 20
    const totalNew = nvda!.tranches.reduce((s, t) => s + t.newShares, 0);
    expect(totalNew).toBe(20);
  });

  it('resizes sell tranches — cancels old, creates fresh weekly', () => {
    const result = run(['test-basket'], db);
    const sofi = result.resized.find(r => r.symbol === 'SOFI');

    expect(sofi).toBeDefined();
    expect(sofi!.action).toBe('resized');
    expect(sofi!.oldTotal).toBe(200);
    expect(sofi!.newTotal).toBe(250);
    // Creates 6 fresh weekly tranches (default)
    expect(sofi!.tranches.length).toBe(6);

    const totalNew = sofi!.tranches.reduce((s, t) => s + t.newShares, 0);
    expect(totalNew).toBe(250);

    // Each tranche should have a trigger date
    for (const t of sofi!.tranches) {
      expect(t.triggerDate).toBeDefined();
    }
  });

  it('distributes remainder to last tranche', () => {
    const result = run(['test-basket'], db);
    const nvda = result.resized.find(r => r.symbol === 'NVDA');

    // 20 shares across 6 fresh tranches: 3,3,3,3,3,5 (remainder 2 goes to last)
    expect(nvda!.tranches.length).toBe(6);
    expect(nvda!.tranches[0].newShares).toBe(3);
    expect(nvda!.tranches[4].newShares).toBe(3);
    expect(nvda!.tranches[5].newShares).toBe(5); // 3 + remainder 2
  });

  it('cancels tranches when target already reached', () => {
    // Set NVDA to already be at target: 80 shares, target 10% → need 50, has 80 → 0 need
    db.exec(`UPDATE position_intents SET target_allocation_pct = 10.0 WHERE id = 'int-nvda'`);
    db.exec(`UPDATE entry_plans SET target_allocation_pct = 10.0 WHERE id = 'ep-nvda-buy'`);

    const result = run(['test-basket'], db);
    const nvda = result.resized.find(r => r.symbol === 'NVDA');

    expect(nvda).toBeDefined();
    expect(nvda!.action).toBe('cancelled');
    expect(nvda!.newTotal).toBe(0);

    // Verify DB state
    const pending = db.prepare(
      `SELECT COUNT(*) as cnt FROM entry_plan_tranches WHERE plan_id = 'ep-nvda-buy' AND status = 'pending'`
    ).get() as { cnt: number };
    expect(pending.cnt).toBe(0);

    const cancelled = db.prepare(
      `SELECT COUNT(*) as cnt FROM entry_plan_tranches WHERE plan_id = 'ep-nvda-buy' AND status = 'cancelled'`
    ).get() as { cnt: number };
    expect(cancelled.cnt).toBe(6);
  });

  it('recreates tranches even when total is the same', () => {
    // Set NVDA need to exactly 60 — resize still cancels old and creates fresh
    db.exec(`UPDATE position_intents SET target_allocation_pct = 28.0 WHERE id = 'int-nvda'`);

    const result = run(['test-basket'], db);
    const nvda = result.resized.find(r => r.symbol === 'NVDA');

    expect(nvda).toBeDefined();
    expect(nvda!.action).toBe('resized');
    expect(nvda!.newTotal).toBe(60);
    expect(nvda!.tranches.length).toBe(6); // fresh weekly tranches
  });

  it('skips symbols with no target allocation', () => {
    // Remove NVDA intent
    db.exec(`DELETE FROM position_intents WHERE id = 'int-nvda'`);

    const result = run(['test-basket'], db);
    const nvdaSkipped = result.skipped.find(s => s.symbol === 'NVDA');
    expect(nvdaSkipped).toBeDefined();
    expect(nvdaSkipped!.reason).toBe('no target allocation set');
  });

  it('skips symbols with no price data', () => {
    // Remove NVDA price history
    db.exec(`DELETE FROM price_history WHERE security_id = 'sec-nvda'`);

    const result = run(['test-basket'], db);
    const nvdaSkipped = result.skipped.find(s => s.symbol === 'NVDA');
    expect(nvdaSkipped).toBeDefined();
    expect(nvdaSkipped!.reason).toBe('no price data');
  });

  it('accounts for already-filled tranches', () => {
    // Mark 2 NVDA tranches as filled (10 shares each = 20 filled)
    db.exec(`
      UPDATE entry_plan_tranches SET status = 'filled', filled_qty = 10
      WHERE id IN ('ept-nvda-1', 'ept-nvda-2')
    `);

    // Now: need 20, filled 20, remaining = 0 → should cancel remaining 4 pending
    const result = run(['test-basket'], db);
    const nvda = result.resized.find(r => r.symbol === 'NVDA');

    expect(nvda).toBeDefined();
    expect(nvda!.action).toBe('cancelled');
    expect(nvda!.newTotal).toBe(0);
  });

  it('returns correct portfolio total including cash', () => {
    const result = run(['test-basket'], db);
    // GOOG 150×280 + NVDA 80×150 + SOFI 500×12 + cash 15000 = 75000
    expect(result.portfolioTotal).toBe(75000);
  });

  it('throws for unknown basket', () => {
    expect(() => run(['nonexistent'], db)).toThrow("Basket 'nonexistent' not found");
  });

  it('throws when no basket name provided', () => {
    expect(() => run([], db)).toThrow('Usage');
  });

  it('persists resized shares to database', () => {
    run(['test-basket'], db);

    // Verify NVDA tranches in DB have new share counts
    const tranches = db.prepare(
      `SELECT shares FROM entry_plan_tranches WHERE plan_id = 'ep-nvda-buy' AND status = 'pending' ORDER BY tranche_number`
    ).all() as { shares: number }[];

    const total = tranches.reduce((s, t) => s + t.shares, 0);
    expect(total).toBe(20);
  });

  it('uses close price only, not pre/post-market', () => {
    // price_history only stores close prices — this test verifies the query
    // reads from price_history.close_price and nothing else
    const result = run(['test-basket'], db);
    const nvda = result.resized.find(r => r.symbol === 'NVDA');
    expect(nvda!.price).toBe(150); // the close_price we seeded
  });

  it('resizes correctly when price drops (need more shares)', () => {
    // Drop NVDA price to $100: target 20% = $15,000 → 150 shares, has 80 → need 70
    db.exec(`UPDATE price_history SET close_price = 100.00 WHERE id = 'ph-nvda'`);

    const result = run(['test-basket'], db);
    const nvda = result.resized.find(r => r.symbol === 'NVDA');

    // Portfolio total changes: GOOG 150×280 + NVDA 80×100 + SOFI 500×12 + cash 15000 = 71000
    // target = 71000 * 0.20 / 100 = 142, has 80, need 62
    expect(nvda!.action).toBe('resized');
    expect(nvda!.newTotal).toBe(62);
  });
});
