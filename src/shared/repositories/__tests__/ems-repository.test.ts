import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedPortfolio, seedBasket } from './fixture';
import { EMSRepository } from '../ems-repository';

let db: Database.Database;
let repo: EMSRepository;

beforeEach(() => {
  db = createTestDb();
  seedPortfolio(db);
  seedBasket(db);
  repo = new EMSRepository(db);
});

describe('EMSRepository', () => {
  describe('getAllBaskets', () => {
    it('returns all baskets with tranche counts by status', () => {
      const baskets = repo.getAllBaskets();

      expect(baskets).toHaveLength(1);
      const basket = baskets[0];

      expect(basket.name).toBe('test-basket');
      expect(basket.status).toBe('active');
      expect(basket.planCount).toBe(2); // NVDA buy, SOFI sell
      expect(basket.trancheCount).toBe(8); // 6 NVDA + 2 SOFI
      expect(basket.pendingTranches).toBe(8); // all pending initially
      expect(basket.triggeredTranches).toBe(0);
      expect(basket.submittedTranches).toBe(0);
      expect(basket.filledTranches).toBe(0);
    });

    it('returns empty array when no baskets exist', () => {
      db.exec('DELETE FROM rebalance_baskets');
      const baskets = repo.getAllBaskets();

      expect(baskets).toHaveLength(0);
    });

    it('handles baskets with no plans', () => {
      const now = new Date().toISOString();
      db.exec(`
        INSERT INTO rebalance_baskets (id, name, status, created_at, updated_at)
        VALUES ('bsk-empty', 'empty-basket', 'active', '${now}', '${now}')
      `);

      const baskets = repo.getAllBaskets();
      const empty = baskets.find(b => b.name === 'empty-basket');

      expect(empty).toBeDefined();
      expect(empty!.planCount).toBe(0);
      expect(empty!.trancheCount).toBe(0);
    });

    it('sorts baskets by created_at DESC', () => {
      const now = new Date().toISOString();
      db.exec(`
        INSERT INTO rebalance_baskets (id, name, status, created_at, updated_at)
        VALUES ('bsk-newer', 'newer-basket', 'active', '${now}', '${now}')
      `);

      const baskets = repo.getAllBaskets();

      expect(baskets[0].name).toBe('newer-basket'); // newest first
      expect(baskets[1].name).toBe('test-basket');
    });

    it('counts tranches by status correctly', () => {
      // Trigger one tranche, submit another, fill a third
      db.exec(`UPDATE entry_plan_tranches SET status = 'triggered' WHERE id = 'ept-nvda-1'`);
      db.exec(`UPDATE entry_plan_tranches SET status = 'submitted' WHERE id = 'ept-nvda-2'`);
      db.exec(`
        UPDATE entry_plan_tranches
        SET status = 'filled', filled_at = datetime('now'), filled_qty = 10, filled_price = 145
        WHERE id = 'ept-nvda-3'
      `);

      const baskets = repo.getAllBaskets();
      const basket = baskets[0];

      expect(basket.pendingTranches).toBe(5); // 8 total - 3 changed
      expect(basket.triggeredTranches).toBe(1);
      expect(basket.submittedTranches).toBe(1);
      expect(basket.filledTranches).toBe(1);
    });
  });

  describe('getBasketByName', () => {
    it('returns basket with all plans and tranches', () => {
      const basket = repo.getBasketByName('test-basket');

      expect(basket).not.toBeNull();
      expect(basket!.name).toBe('test-basket');
      expect(basket!.status).toBe('active');
      expect(basket!.plans).toHaveLength(2);

      // Check NVDA buy plan
      const nvdaPlan = basket!.plans.find(p => p.symbol === 'NVDA');
      expect(nvdaPlan).toBeDefined();
      expect(nvdaPlan!.side).toBe('buy');
      expect(nvdaPlan!.targetAllocationPct).toBe(20.0);
      expect(nvdaPlan!.tranches).toHaveLength(6);

      // Check SOFI sell plan
      const sofiPlan = basket!.plans.find(p => p.symbol === 'SOFI');
      expect(sofiPlan).toBeDefined();
      expect(sofiPlan!.side).toBe('sell');
      expect(sofiPlan!.targetAllocationPct).toBe(4.0);
      expect(sofiPlan!.tranches).toHaveLength(2);
    });

    it('includes tranche details with trigger information', () => {
      const basket = repo.getBasketByName('test-basket');
      const nvdaPlan = basket!.plans.find(p => p.symbol === 'NVDA');
      const tranche = nvdaPlan!.tranches[0];

      expect(tranche.trancheNumber).toBe(1);
      expect(tranche.shares).toBe(10);
      expect(tranche.status).toBe('pending');
      expect(tranche.triggerType).toBe('date');
      expect(tranche.triggerDate).toBe('2026-04-01');
      expect(tranche.triggerPrice).toBe(0);
      expect(tranche.limitPrice).toBeNull();
      expect(tranche.brokerageOrderId).toBeNull();
    });

    it('returns null for non-existent basket', () => {
      const basket = repo.getBasketByName('does-not-exist');
      expect(basket).toBeNull();
    });

    it('sorts plans by symbol and side', () => {
      const basket = repo.getBasketByName('test-basket');
      const symbols = basket!.plans.map(p => `${p.symbol}-${p.side}`);

      // NVDA-buy comes before SOFI-sell
      expect(symbols).toEqual(['NVDA-buy', 'SOFI-sell']);
    });

    it('sorts tranches by tranche_number', () => {
      const basket = repo.getBasketByName('test-basket');
      const nvdaPlan = basket!.plans.find(p => p.symbol === 'NVDA');
      const trancheNumbers = nvdaPlan!.tranches.map(t => t.trancheNumber);

      expect(trancheNumbers).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('includes filled tranche details', () => {
      // Fill a tranche
      db.exec(`
        UPDATE entry_plan_tranches
        SET
          status = 'filled',
          filled_at = '2026-04-01T10:00:00Z',
          filled_qty = 10,
          filled_price = 145.50,
          brokerage_order_id = 'ORD-123',
          brokerage_order_status = 'FILLED'
        WHERE id = 'ept-nvda-1'
      `);

      const basket = repo.getBasketByName('test-basket');
      const nvdaPlan = basket!.plans.find(p => p.symbol === 'NVDA');
      const tranche = nvdaPlan!.tranches[0];

      expect(tranche.status).toBe('filled');
      expect(tranche.filledAt).toBe('2026-04-01T10:00:00Z');
      expect(tranche.filledQty).toBe(10);
      expect(tranche.filledPrice).toBe(145.50);
      expect(tranche.brokerageOrderId).toBe('ORD-123');
      expect(tranche.brokerageOrderStatus).toBe('FILLED');
    });
  });

  describe('getTriggeredOrders', () => {
    beforeEach(() => {
      // Trigger some tranches
      db.exec(`UPDATE entry_plan_tranches SET status = 'triggered' WHERE id IN ('ept-nvda-1', 'ept-nvda-2')`);
      db.exec(`UPDATE entry_plan_tranches SET status = 'submitted', brokerage_order_id = 'ORD-123' WHERE id = 'ept-sofi-1'`);
    });

    it('returns all triggered and submitted tranches', () => {
      const orders = repo.getTriggeredOrders();

      expect(orders).toHaveLength(3);
      expect(orders.filter(o => o.status === 'triggered')).toHaveLength(2);
      expect(orders.filter(o => o.status === 'submitted')).toHaveLength(1);
    });

    it('includes basket and symbol information', () => {
      const orders = repo.getTriggeredOrders();
      const nvdaOrder = orders.find(o => o.symbol === 'NVDA');

      expect(nvdaOrder).toBeDefined();
      expect(nvdaOrder!.basketName).toBe('test-basket');
      expect(nvdaOrder!.side).toBe('buy');
      expect(nvdaOrder!.shares).toBe(10);
    });

    it('filters by basket name', () => {
      const orders = repo.getTriggeredOrders('test-basket');
      expect(orders).toHaveLength(3);

      const noOrders = repo.getTriggeredOrders('other-basket');
      expect(noOrders).toHaveLength(0);
    });

    it('excludes pending and filled tranches', () => {
      db.exec(`UPDATE entry_plan_tranches SET status = 'filled' WHERE id = 'ept-nvda-1'`);

      const orders = repo.getTriggeredOrders();
      expect(orders).toHaveLength(2); // only triggered + submitted
    });

    it('includes brokerage order information', () => {
      const orders = repo.getTriggeredOrders();
      const submittedOrder = orders.find(o => o.status === 'submitted');

      expect(submittedOrder!.brokerageOrderId).toBe('ORD-123');
    });

    it('sorts by basket name, symbol, tranche number', () => {
      // Create another basket to test sorting
      const now = new Date().toISOString();
      db.exec(`
        INSERT INTO rebalance_baskets (id, name, status, created_at, updated_at)
        VALUES ('bsk-2', 'aaa-basket', 'active', '${now}', '${now}')
      `);
      db.exec(`
        INSERT INTO entry_plans (id, security_id, basket_id, side, status, created_at, updated_at)
        VALUES ('ep-goog', 'sec-goog', 'bsk-2', 'buy', 'active', '${now}', '${now}')
      `);
      db.exec(`
        INSERT INTO entry_plan_tranches (id, plan_id, tranche_number, trigger_price, shares, status, trigger_type)
        VALUES ('ept-goog-1', 'ep-goog', 1, 0, 20, 'triggered', 'date')
      `);

      const orders = repo.getTriggeredOrders();

      // aaa-basket should come first alphabetically
      expect(orders[0].basketName).toBe('aaa-basket');
    });
  });

  describe('getFills', () => {
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

    it('returns all filled tranches', () => {
      const fills = repo.getFills();

      expect(fills).toHaveLength(2);
    });

    it('includes fill details', () => {
      const fills = repo.getFills();
      const nvdaFill = fills.find(f => f.symbol === 'NVDA');

      expect(nvdaFill).toBeDefined();
      expect(nvdaFill!.basketName).toBe('test-basket');
      expect(nvdaFill!.side).toBe('buy');
      expect(nvdaFill!.shares).toBe(10);
      expect(nvdaFill!.filledQty).toBe(10);
      expect(nvdaFill!.filledPrice).toBe(145.50);
      expect(nvdaFill!.filledAt).toBe('2026-04-01T10:00:00Z');
      expect(nvdaFill!.brokerageOrderId).toBe('ORD-1');
    });

    it('filters by basket name', () => {
      const fills = repo.getFills('test-basket');
      expect(fills).toHaveLength(2);

      const noFills = repo.getFills('other-basket');
      expect(noFills).toHaveLength(0);
    });

    it('sorts by filled_at DESC (newest first)', () => {
      const fills = repo.getFills();

      // Most recent fill should be first
      expect(fills[0].filledAt).toBe('2026-04-02T11:00:00Z'); // SOFI
      expect(fills[1].filledAt).toBe('2026-04-01T10:00:00Z'); // NVDA
    });

    it('excludes non-filled tranches', () => {
      db.exec(`UPDATE entry_plan_tranches SET status = 'triggered' WHERE id = 'ept-nvda-2'`);

      const fills = repo.getFills();
      expect(fills).toHaveLength(2); // only filled ones
    });

    it('excludes filled tranches without filled_at timestamp', () => {
      // Edge case: status is filled but filled_at is NULL
      db.exec(`
        UPDATE entry_plan_tranches
        SET status = 'filled', filled_at = NULL
        WHERE id = 'ept-nvda-3'
      `);

      const fills = repo.getFills();
      expect(fills).toHaveLength(2); // excludes the one without timestamp
    });
  });

  describe('getStatusSummary', () => {
    it('returns overall EMS statistics', () => {
      const summary = repo.getStatusSummary();

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

      const summary = repo.getStatusSummary();

      expect(summary.pending).toBe(4);
      expect(summary.triggered).toBe(2);
      expect(summary.submitted).toBe(1);
      expect(summary.filled).toBe(1);
    });

    it('counts only active baskets', () => {
      db.exec(`UPDATE rebalance_baskets SET status = 'completed' WHERE id = 'bsk-1'`);

      const summary = repo.getStatusSummary();

      expect(summary.totalBaskets).toBe(1);
      expect(summary.activeBaskets).toBe(0);
    });

    it('handles empty database', () => {
      db.exec('DELETE FROM rebalance_baskets');

      const summary = repo.getStatusSummary();

      expect(summary.totalBaskets).toBe(0);
      expect(summary.activeBaskets).toBe(0);
      expect(summary.totalTranches).toBe(0);
      expect(summary.pending).toBe(0);
    });
  });

  describe('getTrancheById', () => {
    it('returns tranche with plan and basket context', () => {
      const tranche = repo.getTrancheById('ept-nvda-1');

      expect(tranche).not.toBeNull();
      expect(tranche!.id).toBe('ept-nvda-1');
      expect(tranche!.symbol).toBe('NVDA');
      expect(tranche!.side).toBe('buy');
      expect(tranche!.basketName).toBe('test-basket');
      expect(tranche!.trancheNumber).toBe(1);
      expect(tranche!.shares).toBe(10);
      expect(tranche!.status).toBe('pending');
    });

    it('returns null for non-existent tranche', () => {
      const tranche = repo.getTrancheById('does-not-exist');
      expect(tranche).toBeNull();
    });

    it('includes all tranche fields', () => {
      db.exec(`
        UPDATE entry_plan_tranches
        SET
          status = 'filled',
          limit_price = 142.50,
          filled_at = '2026-04-01T10:00:00Z',
          filled_qty = 10,
          filled_price = 143.00,
          brokerage_order_id = 'ORD-123',
          brokerage_order_status = 'FILLED',
          notes = 'Test fill'
        WHERE id = 'ept-nvda-1'
      `);

      const tranche = repo.getTrancheById('ept-nvda-1');

      expect(tranche!.limitPrice).toBe(142.50);
      expect(tranche!.filledAt).toBe('2026-04-01T10:00:00Z');
      expect(tranche!.filledQty).toBe(10);
      expect(tranche!.filledPrice).toBe(143.00);
      expect(tranche!.brokerageOrderId).toBe('ORD-123');
      expect(tranche!.brokerageOrderStatus).toBe('FILLED');
      expect(tranche!.notes).toBe('Test fill');
    });
  });

  describe('database constraints', () => {
    it('CASCADE deletes plans when basket is deleted', () => {
      db.exec("DELETE FROM rebalance_baskets WHERE name = 'test-basket'");

      // Plans should be gone
      const plans = db.prepare('SELECT * FROM entry_plans WHERE basket_id = ?').all('bsk-1');
      expect(plans).toHaveLength(0);
    });

    it('CASCADE deletes tranches when plan is deleted', () => {
      db.exec("DELETE FROM entry_plans WHERE id = 'ep-nvda-buy'");

      // Tranches should be gone
      const tranches = db.prepare('SELECT * FROM entry_plan_tranches WHERE plan_id = ?').all('ep-nvda-buy');
      expect(tranches).toHaveLength(0);
    });
  });
});
