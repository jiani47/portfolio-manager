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

    it('throws error for non-existent basket', () => {
      expect(() => {
        run(['basket', 'does-not-exist'], db);
      }).toThrow('Basket not found: does-not-exist');
    });

    it('requires basket name argument', () => {
      expect(() => {
        run(['basket'], db);
      }).toThrow('Usage: ems basket <name>');
    });
  });

  describe('basket-create', () => {
    it('creates new basket with notes', () => {
      const result = run(['basket-create', 'new-basket', 'Test notes'], db) as EMSResult;

      expect(result.command).toBe('basket-create');
      const data = result.data as any;
      expect(data.message).toContain('Basket created: new-basket');
      expect(data.basketId).toBeDefined();

      // Verify it was created
      const row = db.prepare('SELECT * FROM rebalance_baskets WHERE name = ?').get('new-basket') as any;
      expect(row).toBeDefined();
      expect(row.notes).toBe('Test notes');
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

    it('throws error for duplicate basket name', () => {
      expect(() => {
        run(['basket-create', 'test-basket'], db);
      }).toThrow('Basket already exists: test-basket');
    });

    it('requires basket name argument', () => {
      expect(() => {
        run(['basket-create'], db);
      }).toThrow('Usage: ems basket-create <name>');
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

  describe('unknown subcommand', () => {
    it('throws error for unknown subcommand', () => {
      expect(() => {
        run(['unknown'], db);
      }).toThrow('Unknown subcommand: unknown');
    });
  });
});
