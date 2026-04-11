import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedPortfolio, seedBasket } from '../../../shared/repositories/__tests__/fixture';
import { run, type EMSResult } from '../ems';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  seedPortfolio(db);
  seedBasket(db);
});

describe('ems CLI command', () => {
  describe('baskets', () => {
    it('returns all baskets with tranche counts', () => {
      const result = run([], db) as EMSResult;

      expect(result.command).toBe('baskets');
      expect(Array.isArray(result.data)).toBe(true);

      const baskets = result.data as any[];
      expect(baskets).toHaveLength(1);

      const basket = baskets[0];
      expect(basket.name).toBe('test-basket');
      expect(basket.status).toBe('active');
      expect(basket.planCount).toBe(2);
      expect(basket.trancheCount).toBe(8);
      expect(basket.pendingTranches).toBe(8);
    });

    it('also accepts explicit "baskets" subcommand', () => {
      const result = run(['baskets'], db) as EMSResult;

      expect(result.command).toBe('baskets');
      expect(Array.isArray(result.data)).toBe(true);
    });
  });

  describe('basket', () => {
    it('returns basket with all plans and tranches', () => {
      const result = run(['basket', 'test-basket'], db) as EMSResult;

      expect(result.command).toBe('basket');
      const basket = result.data as any;

      expect(basket.name).toBe('test-basket');
      expect(basket.status).toBe('active');
      expect(basket.plans).toHaveLength(2);

      const nvdaPlan = basket.plans.find((p: any) => p.symbol === 'NVDA');
      expect(nvdaPlan.side).toBe('buy');
      expect(nvdaPlan.tranches).toHaveLength(6);
    });

    it('returns error for non-existent basket', () => {
      const result = run(['basket', 'does-not-exist'], db);
      expect(result.error).toContain('Basket not found');
    });

    it('returns error when basket name missing', () => {
      const result = run(['basket'], db);
      expect(result.error).toContain('Usage: ems basket <name>');
    });
  });

  describe('basket-create', () => {
    it('creates new basket', () => {
      const result = run(['basket-create', 'new-basket'], db) as EMSResult;

      expect(result.command).toBe('basket-create');
      const data = result.data as any;
      expect(data.message).toContain('Basket created: new-basket');
      expect(data.basketId).toBeDefined();

      // Verify it was created
      const row = db.prepare('SELECT * FROM rebalance_baskets WHERE name = ?').get('new-basket') as any;
      expect(row).toBeDefined();
      expect(row.status).toBe('active');
    });

    it('creates basket without notes', () => {
      const result = run(['basket-create', 'minimal-basket'], db) as EMSResult;

      expect(result.command).toBe('basket-create');
      const data = result.data as any;
      expect(data.message).toContain('Basket created: minimal-basket');

      const row = db.prepare('SELECT * FROM rebalance_baskets WHERE name = ?').get('minimal-basket') as any;
      expect(row.notes).toBeNull();
    });

    it('returns error for duplicate basket name', () => {
      const result = run(['basket-create', 'test-basket'], db);
      expect(result.error).toContain('Basket already exists');
    });

    it('returns error when basket name missing', () => {
      const result = run(['basket-create'], db);
      expect(result.error).toContain('Usage: ems basket-create <name>');
    });

    it('returns basket ID in response', () => {
      const result = run(['basket-create', 'id-test'], db) as EMSResult;
      const data = result.data as any;

      expect(data.basketId).toBeDefined();
      expect(typeof data.basketId).toBe('string');
      expect(data.basketId.length).toBeGreaterThan(0);
    });
  });

  describe('basket-orders', () => {
    beforeEach(() => {
      // Trigger and submit some tranches
      db.exec(`UPDATE entry_plan_tranches SET status = 'triggered' WHERE id IN ('ept-nvda-1', 'ept-nvda-2')`);
      db.exec(`UPDATE entry_plan_tranches SET status = 'submitted', brokerage_order_id = 'ORD-123' WHERE id = 'ept-sofi-1'`);
    });

    it('returns all triggered and submitted orders', () => {
      const result = run(['basket-orders'], db) as EMSResult;

      expect(result.command).toBe('basket-orders');
      const orders = result.data as any[];

      expect(orders).toHaveLength(3);
      expect(orders.filter(o => o.status === 'triggered')).toHaveLength(2);
      expect(orders.filter(o => o.status === 'submitted')).toHaveLength(1);
    });

    it('includes order details', () => {
      const result = run(['basket-orders'], db) as EMSResult;
      const orders = result.data as any[];

      const nvdaOrder = orders.find(o => o.symbol === 'NVDA');
      expect(nvdaOrder).toBeDefined();
      expect(nvdaOrder.basketName).toBe('test-basket');
      expect(nvdaOrder.side).toBe('buy');
      expect(nvdaOrder.shares).toBe(10);
      expect(nvdaOrder.triggerType).toBe('date');
    });

    it('filters by basket name', () => {
      const result = run(['basket-orders', 'test-basket'], db) as EMSResult;
      const orders = result.data as any[];

      expect(orders).toHaveLength(3);

      // Non-existent basket returns empty
      const result2 = run(['basket-orders', 'other-basket'], db) as EMSResult;
      const orders2 = result2.data as any[];
      expect(orders2).toHaveLength(0);
    });

    it('excludes pending and filled tranches', () => {
      db.exec(`UPDATE entry_plan_tranches SET status = 'filled' WHERE id = 'ept-nvda-1'`);

      const result = run(['basket-orders'], db) as EMSResult;
      const orders = result.data as any[];

      expect(orders).toHaveLength(2); // only triggered + submitted
      expect(orders.every(o => ['triggered', 'submitted'].includes(o.status))).toBe(true);
    });
  });

  describe('basket-fills', () => {
    beforeEach(() => {
      // Fill some tranches
      db.exec(`
        UPDATE entry_plan_tranches
        SET
          status = 'filled',
          filled_at = '2026-04-01T10:00:00Z',
          filled_qty = 10,
          filled_price = 145.50,
          brokerage_order_id = 'ORD-1'
        WHERE id = 'ept-nvda-1'
      `);
      db.exec(`
        UPDATE entry_plan_tranches
        SET
          status = 'filled',
          filled_at = '2026-04-02T11:00:00Z',
          filled_qty = 100,
          filled_price = 11.75,
          brokerage_order_id = 'ORD-2'
        WHERE id = 'ept-sofi-1'
      `);
    });

    it('returns all fills', () => {
      const result = run(['basket-fills'], db) as EMSResult;

      expect(result.command).toBe('basket-fills');
      const fills = result.data as any[];

      expect(fills).toHaveLength(2);
    });

    it('includes fill details', () => {
      const result = run(['basket-fills'], db) as EMSResult;
      const fills = result.data as any[];

      const nvdaFill = fills.find(f => f.symbol === 'NVDA');
      expect(nvdaFill).toBeDefined();
      expect(nvdaFill.basketName).toBe('test-basket');
      expect(nvdaFill.side).toBe('buy');
      expect(nvdaFill.shares).toBe(10);
      expect(nvdaFill.filledQty).toBe(10);
      expect(nvdaFill.filledPrice).toBe(145.50);
      expect(nvdaFill.filledAt).toBe('2026-04-01T10:00:00Z');
      expect(nvdaFill.brokerageOrderId).toBe('ORD-1');
    });

    it('filters by basket name', () => {
      const result = run(['basket-fills', 'test-basket'], db) as EMSResult;
      const fills = result.data as any[];

      expect(fills).toHaveLength(2);

      // Non-existent basket returns empty
      const result2 = run(['basket-fills', 'other-basket'], db) as EMSResult;
      const fills2 = result2.data as any[];
      expect(fills2).toHaveLength(0);
    });

    it('sorts by filled_at DESC (newest first)', () => {
      const result = run(['basket-fills'], db) as EMSResult;
      const fills = result.data as any[];

      // Most recent should be first
      expect(fills[0].filledAt).toBe('2026-04-02T11:00:00Z'); // SOFI
      expect(fills[1].filledAt).toBe('2026-04-01T10:00:00Z'); // NVDA
    });
  });

  describe('basket-status', () => {
    it('returns overall EMS statistics', () => {
      const result = run(['basket-status'], db) as EMSResult;

      expect(result.command).toBe('basket-status');
      const summary = result.data as any;

      expect(summary.totalBaskets).toBe(1);
      expect(summary.activeBaskets).toBe(1);
      expect(summary.totalTranches).toBe(8);
      expect(summary.pending).toBe(8);
      expect(summary.triggered).toBe(0);
      expect(summary.submitted).toBe(0);
      expect(summary.filled).toBe(0);
    });

    it('counts different tranche statuses', () => {
      db.exec(`UPDATE entry_plan_tranches SET status = 'triggered' WHERE id IN ('ept-nvda-1', 'ept-nvda-2')`);
      db.exec(`UPDATE entry_plan_tranches SET status = 'submitted' WHERE id = 'ept-sofi-1'`);
      db.exec(`
        UPDATE entry_plan_tranches
        SET status = 'filled', filled_at = datetime('now'), filled_qty = 10, filled_price = 145
        WHERE id = 'ept-nvda-3'
      `);

      const result = run(['basket-status'], db) as EMSResult;
      const summary = result.data as any;

      expect(summary.pending).toBe(4);
      expect(summary.triggered).toBe(2);
      expect(summary.submitted).toBe(1);
      expect(summary.filled).toBe(1);
    });

    it('counts only active baskets', () => {
      db.exec(`UPDATE rebalance_baskets SET status = 'completed' WHERE id = 'bsk-1'`);

      const result = run(['basket-status'], db) as EMSResult;
      const summary = result.data as any;

      expect(summary.totalBaskets).toBe(1);
      expect(summary.activeBaskets).toBe(0);
    });

    it('handles empty database', () => {
      // Delete all tranches, plans, baskets
      db.exec('DELETE FROM rebalance_baskets');

      const result = run(['basket-status'], db) as EMSResult;
      const summary = result.data as any;

      expect(summary.totalBaskets).toBe(0);
      expect(summary.activeBaskets).toBe(0);
      expect(summary.totalTranches).toBe(0);
      expect(summary.pending).toBe(0);
    });
  });

  describe('basket-add', () => {
    it('adds entry plan with date-triggered tranches', () => {
      const result = run([
        'basket-add',
        'test-basket',
        'buy',
        'GOOG',
        '50',
        '2',
        'date',
        '2026-05-01,2026-05-15',
      ], db);

      expect(result.error).toBeUndefined();
      expect(result.command).toBe('basket-add');
      const data = result.data as any;

      expect(data.symbol).toBe('GOOG');
      expect(data.side).toBe('buy');
      expect(data.totalShares).toBe(50);
      expect(data.tranches).toHaveLength(2);
      expect(data.tranches[0].shares).toBe(25);
      expect(data.tranches[1].shares).toBe(25);
      expect(data.tranches[0].trigger.type).toBe('date');
      expect(data.tranches[0].trigger.value).toBe('2026-05-01');

      // Verify in database
      const plan = db.prepare('SELECT * FROM entry_plans WHERE id = ?').get(data.planId) as any;
      expect(plan.side).toBe('buy');

      const tranches = db.prepare('SELECT * FROM entry_plan_tranches WHERE plan_id = ? ORDER BY tranche_number').all(data.planId);
      expect(tranches).toHaveLength(2);
    });

    it('adds entry plan with price-triggered tranches and monitors', () => {
      const result = run([
        'basket-add',
        'test-basket',
        'sell',
        'NVDA',
        '100',
        '3',
        'price',
        '200,190,180',
      ], db);

      expect(result.error).toBeUndefined();
      const data = result.data as any;

      expect(data.tranches).toHaveLength(3);
      expect(data.tranches[0].trigger.type).toBe('price');
      expect(data.tranches[0].trigger.value).toBe(200);
      expect(data.tranches[0].trigger.direction).toBe('above'); // sell triggers above

      // Verify monitors created
      const monitors = db.prepare('SELECT * FROM monitors WHERE label LIKE ?').all(`EMS sell NVDA%`);
      expect(monitors).toHaveLength(3);
    });

    it('distributes shares correctly with remainder', () => {
      const result = run([
        'basket-add',
        'test-basket',
        'buy',
        'SOFI',
        '100',
        '3',
        'date',
        '2026-06-01',
      ], db);

      const data = result.data as any;
      expect(data.tranches[0].shares).toBe(33); // 100 / 3 = 33
      expect(data.tranches[1].shares).toBe(33);
      expect(data.tranches[2].shares).toBe(34); // last one gets remainder
    });

    it('adds plan with invalidation condition', () => {
      const result = run([
        'basket-add',
        'test-basket',
        'buy',
        'GOOG',
        '10',
        '1',
        'date',
        '2026-06-01',
        '--invalidation',
        'Search share drops below 80%',
      ], db);

      const data = result.data as any;
      expect(data.invalidation).toBe('Search share drops below 80%');

      const plan = db.prepare('SELECT * FROM entry_plans WHERE id = ?').get(data.planId) as any;
      expect(plan.invalidation_condition).toBe('Search share drops below 80%');
    });

    it('creates invalidation monitor when --invalidation-price provided', () => {
      const result = run([
        'basket-add',
        'test-basket',
        'buy',
        'NVDA',
        '10',
        '1',
        'date',
        '2026-06-01',
        '--invalidation-price',
        'NVDA',
        'below',
        '120',
      ], db);

      const data = result.data as any;
      const plan = db.prepare('SELECT * FROM entry_plans WHERE id = ?').get(data.planId) as any;

      expect(plan.invalidation_monitor_id).toBeTruthy();

      const monitor = db.prepare('SELECT * FROM monitors WHERE id = ?').get(plan.invalidation_monitor_id) as any;
      expect(monitor.symbol).toBe('NVDA');
      expect(monitor.direction).toBe('below');
      expect(monitor.price_level).toBe(120);
    });

    it('throws error for non-existent basket', () => {
      const result = run([
        'basket-add',
        'missing-basket',
        'buy',
        'GOOG',
        '10',
        '1',
        'date',
        '2026-06-01',
      ], db);

      expect(result.error).toContain('Active basket not found');
    });

    it('throws error for non-existent security', () => {
      const result = run([
        'basket-add',
        'test-basket',
        'buy',
        'BADTICKER',
        '10',
        '1',
        'date',
        '2026-06-01',
      ], db);

      expect(result.error).toContain('Security not found');
    });
  });

  describe('basket-cancel', () => {
    beforeEach(() => {
      // Create a tranche to cancel
      db.exec(`
        INSERT INTO entry_plan_tranches (id, plan_id, tranche_number, trigger_price, shares, status)
        VALUES ('cancel-test-1', 'ep-nvda-buy', 99, 150, 10, 'pending')
      `);
    });

    it('cancels a pending tranche', () => {
      const result = run(['basket-cancel', 'cancel-test-1'], db);

      expect(result.error).toBeUndefined();
      expect(result.command).toBe('basket-cancel');
      const data = result.data as any;

      expect(data.message).toContain('Cancelled tranche');

      // Verify in database
      const tranche = db.prepare('SELECT status FROM entry_plan_tranches WHERE id = ?').get('cancel-test-1') as any;
      expect(tranche.status).toBe('cancelled');
    });

    it('works with partial tranche ID', () => {
      const result = run(['basket-cancel', 'cancel'], db);

      expect(result.error).toBeUndefined();

      const tranche = db.prepare('SELECT status FROM entry_plan_tranches WHERE id LIKE ?').get('cancel%') as any;
      expect(tranche.status).toBe('cancelled');
    });

    it('throws error for filled tranche', () => {
      db.exec("UPDATE entry_plan_tranches SET status = 'filled' WHERE id = 'cancel-test-1'");

      const result = run(['basket-cancel', 'cancel-test-1'], db);

      expect(result.error).toContain('Cannot cancel filled tranche');
    });

    it('throws error for non-existent tranche', () => {
      const result = run(['basket-cancel', 'does-not-exist'], db);

      expect(result.error).toContain('Tranche not found');
    });
  });

  describe('basket-fill', () => {
    beforeEach(() => {
      // Create a tranche to fill
      db.exec(`
        INSERT INTO entry_plan_tranches (id, plan_id, tranche_number, trigger_price, shares, status, filled_qty, filled_price)
        VALUES ('fill-test-1', 'ep-nvda-buy', 98, 150, 100, 'submitted', 0, NULL)
      `);
    });

    it('records a full fill', () => {
      const result = run(['basket-fill', 'fill-test-1', '100', '145.50'], db);

      expect(result.error).toBeUndefined();
      expect(result.command).toBe('basket-fill');
      const data = result.data as any;

      expect(data.symbol).toBe('NVDA');
      expect(data.fillQty).toBe(100);
      expect(data.fillPrice).toBe(145.50);
      expect(data.totalFilled).toBe(100);
      expect(data.status).toBe('filled');

      // Verify in database
      const tranche = db.prepare('SELECT * FROM entry_plan_tranches WHERE id = ?').get('fill-test-1') as any;
      expect(tranche.status).toBe('filled');
      expect(tranche.filled_qty).toBe(100);
      expect(tranche.filled_price).toBe(145.50);
      expect(tranche.brokerage_order_status).toBe('FILLED');
    });

    it('records a partial fill', () => {
      const result = run(['basket-fill', 'fill-test-1', '50', '145.00'], db);

      expect(result.error).toBeUndefined();
      const data = result.data as any;

      expect(data.totalFilled).toBe(50);
      expect(data.totalShares).toBe(100);
      expect(data.status).toBe('submitted'); // still submitted, not fully filled

      const tranche = db.prepare('SELECT * FROM entry_plan_tranches WHERE id = ?').get('fill-test-1') as any;
      expect(tranche.status).toBe('submitted');
      expect(tranche.filled_qty).toBe(50);
      expect(tranche.brokerage_order_status).toBe('PARTIAL');
    });

    it('calculates weighted average price for multiple fills', () => {
      // First fill: 50 @ 145
      run(['basket-fill', 'fill-test-1', '50', '145.00'], db);

      // Second fill: 50 @ 150
      const result = run(['basket-fill', 'fill-test-1', '50', '150.00'], db);

      const data = result.data as any;
      expect(data.totalFilled).toBe(100);
      expect(data.avgPrice).toBeCloseTo(147.50, 2); // (50*145 + 50*150) / 100 = 147.50
      expect(data.status).toBe('filled');
    });

    it('throws error when fill exceeds total shares', () => {
      const result = run(['basket-fill', 'fill-test-1', '150', '145.00'], db);

      expect(result.error).toContain('would exceed total shares');
    });

    it('throws error for non-existent tranche', () => {
      const result = run(['basket-fill', 'does-not-exist', '10', '100'], db);

      expect(result.error).toContain('Tranche not found');
    });

    it('works with partial tranche ID', () => {
      const result = run(['basket-fill', 'fill-test', '100', '145.50'], db);

      expect(result.error).toBeUndefined();

      const tranche = db.prepare('SELECT * FROM entry_plan_tranches WHERE id LIKE ?').get('fill-test%') as any;
      expect(tranche.filled_qty).toBe(100);
    });
  });

  describe('unknown subcommand', () => {
    it('throws error for unknown subcommand', () => {
      const result = run(['unknown'], db);
      expect(result.error).toContain('Unknown subcommand');
    });
  });
});
