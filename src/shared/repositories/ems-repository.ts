/**
 * EMSRepository - Data access layer for Execution Management System.
 * Handles queries for baskets, entry plans, and tranches with joins and aggregations.
 */
import type Database from 'better-sqlite3';
import type { RebalanceBasket, EntryPlan, EntryPlanTranche } from '../types';

export interface BasketSummary {
  id: string;
  name: string;
  status: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  planCount: number;
  trancheCount: number;
  pendingTranches: number;
  triggeredTranches: number;
  submittedTranches: number;
  filledTranches: number;
}

export interface BasketDetail {
  id: string;
  name: string;
  status: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  plans: PlanWithTranches[];
}

export interface PlanWithTranches {
  id: string;
  securityId: string;
  symbol: string;
  side: string;
  targetAllocationPct: number | null;
  status: string;
  notes: string | null;
  invalidationCondition: string | null;
  invalidationMonitorId: string | null;
  createdAt: string;
  updatedAt: string;
  tranches: TrancheDetail[];
}

export interface TrancheDetail {
  id: string;
  planId: string;
  trancheNumber: number;
  triggerType: string;
  triggerDate: string | null;
  triggerPrice: number;
  shares: number;
  limitPrice: number | null;
  status: string;
  monitorId: string | null;
  brokerageOrderId: string | null;
  brokerageOrderStatus: string | null;
  filledAt: string | null;
  filledQty: number | null;
  filledPrice: number | null;
  accountId: string | null;
  notes: string | null;
}

export interface TriggeredOrder {
  trancheId: string;
  planId: string;
  basketName: string;
  symbol: string;
  side: string;
  shares: number;
  triggerPrice: number;
  limitPrice: number | null;
  triggerType: string;
  triggerDate: string | null;
  status: string;
  brokerageOrderId: string | null;
  brokerageOrderStatus: string | null;
}

export interface FillRecord {
  trancheId: string;
  basketName: string;
  symbol: string;
  side: string;
  shares: number;
  filledQty: number;
  filledPrice: number;
  filledAt: string;
  brokerageOrderId: string | null;
}

export class EMSRepository {
  constructor(private db: Database.Database) {}

  /**
   * Get all baskets with summary statistics.
   * Used by `baskets` command.
   */
  getAllBaskets(): BasketSummary[] {
    const rows = this.db.prepare(`
      SELECT
        b.id,
        b.name,
        b.status,
        b.created_at,
        b.updated_at,
        COUNT(DISTINCT ep.id) as plan_count,
        COUNT(ept.id) as tranche_count,
        SUM(CASE WHEN ept.status = 'pending' THEN 1 ELSE 0 END) as pending_tranches,
        SUM(CASE WHEN ept.status = 'triggered' THEN 1 ELSE 0 END) as triggered_tranches,
        SUM(CASE WHEN ept.status = 'submitted' THEN 1 ELSE 0 END) as submitted_tranches,
        SUM(CASE WHEN ept.status = 'filled' THEN 1 ELSE 0 END) as filled_tranches
      FROM rebalance_baskets b
      LEFT JOIN entry_plans ep ON b.id = ep.basket_id
      LEFT JOIN entry_plan_tranches ept ON ep.id = ept.plan_id
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `).all() as any[];

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      status: row.status,
      notes: null, // notes column not in production schema yet
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      planCount: row.plan_count || 0,
      trancheCount: row.tranche_count || 0,
      pendingTranches: row.pending_tranches || 0,
      triggeredTranches: row.triggered_tranches || 0,
      submittedTranches: row.submitted_tranches || 0,
      filledTranches: row.filled_tranches || 0,
    }));
  }

  /**
   * Get a basket by name with all plans and tranches.
   * Used by `basket <name>` command.
   */
  getBasketByName(name: string): BasketDetail | null {
    // Get basket
    const basketRow = this.db.prepare(`
      SELECT id, name, status, created_at, updated_at
      FROM rebalance_baskets
      WHERE name = ?
    `).get(name) as any;

    if (!basketRow) {
      return null;
    }

    // Get all plans for this basket
    const planRows = this.db.prepare(`
      SELECT
        ep.id,
        ep.security_id,
        s.symbol,
        ep.side,
        ep.target_allocation_pct,
        ep.status,
        ep.notes,
        ep.invalidation_condition,
        ep.invalidation_monitor_id,
        ep.created_at,
        ep.updated_at
      FROM entry_plans ep
      JOIN securities s ON ep.security_id = s.id
      WHERE ep.basket_id = ?
      ORDER BY s.symbol, ep.side
    `).all(basketRow.id) as any[];

    const plans: PlanWithTranches[] = planRows.map(planRow => {
      // Get tranches for this plan
      const trancheRows = this.db.prepare(`
        SELECT
          id,
          plan_id,
          tranche_number,
          trigger_type,
          trigger_date,
          trigger_price,
          shares,
          limit_price,
          status,
          monitor_id,
          brokerage_order_id,
          brokerage_order_status,
          filled_at,
          filled_qty,
          filled_price,
          account_id,
          notes
        FROM entry_plan_tranches
        WHERE plan_id = ?
        ORDER BY tranche_number
      `).all(planRow.id) as any[];

      const tranches: TrancheDetail[] = trancheRows.map(t => ({
        id: t.id,
        planId: t.plan_id,
        trancheNumber: t.tranche_number,
        triggerType: t.trigger_type || 'price',
        triggerDate: t.trigger_date || null,
        triggerPrice: t.trigger_price || 0,
        shares: t.shares,
        limitPrice: t.limit_price || null,
        status: t.status,
        monitorId: t.monitor_id || null,
        brokerageOrderId: t.brokerage_order_id || null,
        brokerageOrderStatus: t.brokerage_order_status || null,
        filledAt: t.filled_at || null,
        filledQty: t.filled_qty || null,
        filledPrice: t.filled_price || null,
        accountId: t.account_id || null,
        notes: t.notes || null,
      }));

      return {
        id: planRow.id,
        securityId: planRow.security_id,
        symbol: planRow.symbol,
        side: planRow.side || 'buy',
        targetAllocationPct: planRow.target_allocation_pct,
        status: planRow.status,
        notes: planRow.notes,
        invalidationCondition: planRow.invalidation_condition,
        invalidationMonitorId: planRow.invalidation_monitor_id,
        createdAt: planRow.created_at,
        updatedAt: planRow.updated_at,
        tranches,
      };
    });

    return {
      id: basketRow.id,
      name: basketRow.name,
      status: basketRow.status,
      notes: null, // notes column not in production schema yet
      createdAt: basketRow.created_at,
      updatedAt: basketRow.updated_at,
      plans,
    };
  }

  /**
   * Get all triggered tranches awaiting confirmation.
   * Optionally filter by basket name.
   * Used by `basket-orders [basket]` command.
   */
  getTriggeredOrders(basketName?: string): TriggeredOrder[] {
    const sql = `
      SELECT
        ept.id as tranche_id,
        ept.plan_id,
        b.name as basket_name,
        s.symbol,
        ep.side,
        ept.shares,
        ept.trigger_price,
        ept.limit_price,
        ept.trigger_type,
        ept.trigger_date,
        ept.status,
        ept.brokerage_order_id,
        ept.brokerage_order_status
      FROM entry_plan_tranches ept
      JOIN entry_plans ep ON ept.plan_id = ep.id
      JOIN rebalance_baskets b ON ep.basket_id = b.id
      JOIN securities s ON ep.security_id = s.id
      WHERE ept.status IN ('triggered', 'submitted')
      ${basketName ? 'AND b.name = ?' : ''}
      ORDER BY b.name, s.symbol, ept.tranche_number
    `;

    const params = basketName ? [basketName] : [];
    const rows = this.db.prepare(sql).all(params) as any[];

    return rows.map(row => ({
      trancheId: row.tranche_id,
      planId: row.plan_id,
      basketName: row.basket_name,
      symbol: row.symbol,
      side: row.side || 'buy',
      shares: row.shares,
      triggerPrice: row.trigger_price || 0,
      limitPrice: row.limit_price || null,
      triggerType: row.trigger_type || 'price',
      triggerDate: row.trigger_date || null,
      status: row.status,
      brokerageOrderId: row.brokerage_order_id || null,
      brokerageOrderStatus: row.brokerage_order_status || null,
    }));
  }

  /**
   * Get fill history.
   * Optionally filter by basket name.
   * Used by `basket-fills [basket]` command.
   */
  getFills(basketName?: string): FillRecord[] {
    const sql = `
      SELECT
        ept.id as tranche_id,
        b.name as basket_name,
        s.symbol,
        ep.side,
        ept.shares,
        ept.filled_qty,
        ept.filled_price,
        ept.filled_at,
        ept.brokerage_order_id
      FROM entry_plan_tranches ept
      JOIN entry_plans ep ON ept.plan_id = ep.id
      JOIN rebalance_baskets b ON ep.basket_id = b.id
      JOIN securities s ON ep.security_id = s.id
      WHERE ept.status = 'filled' AND ept.filled_at IS NOT NULL
      ${basketName ? 'AND b.name = ?' : ''}
      ORDER BY ept.filled_at DESC
    `;

    const params = basketName ? [basketName] : [];
    const rows = this.db.prepare(sql).all(params) as any[];

    return rows.map(row => ({
      trancheId: row.tranche_id,
      basketName: row.basket_name,
      symbol: row.symbol,
      side: row.side || 'buy',
      shares: row.shares,
      filledQty: row.filled_qty,
      filledPrice: row.filled_price,
      filledAt: row.filled_at,
      brokerageOrderId: row.brokerage_order_id || null,
    }));
  }

  /**
   * Get EMS status summary.
   * Used by `basket-status` command.
   */
  getStatusSummary(): {
    totalBaskets: number;
    activeBaskets: number;
    totalTranches: number;
    pending: number;
    triggered: number;
    submitted: number;
    filled: number;
  } {
    const row = this.db.prepare(`
      SELECT
        COUNT(DISTINCT b.id) as total_baskets,
        COUNT(DISTINCT CASE WHEN b.status = 'active' THEN b.id END) as active_baskets,
        COUNT(ept.id) as total_tranches,
        SUM(CASE WHEN ept.status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN ept.status = 'triggered' THEN 1 ELSE 0 END) as triggered,
        SUM(CASE WHEN ept.status = 'submitted' THEN 1 ELSE 0 END) as submitted,
        SUM(CASE WHEN ept.status = 'filled' THEN 1 ELSE 0 END) as filled
      FROM rebalance_baskets b
      LEFT JOIN entry_plans ep ON b.id = ep.basket_id
      LEFT JOIN entry_plan_tranches ept ON ep.id = ept.plan_id
    `).get() as any;

    return {
      totalBaskets: row.total_baskets || 0,
      activeBaskets: row.active_baskets || 0,
      totalTranches: row.total_tranches || 0,
      pending: row.pending || 0,
      triggered: row.triggered || 0,
      submitted: row.submitted || 0,
      filled: row.filled || 0,
    };
  }

  /**
   * Get a tranche by ID with plan and basket context.
   */
  getTrancheById(id: string): (TrancheDetail & { symbol: string; side: string; basketName: string }) | null {
    const row = this.db.prepare(`
      SELECT
        ept.id,
        ept.plan_id,
        ept.tranche_number,
        ept.trigger_type,
        ept.trigger_date,
        ept.trigger_price,
        ept.shares,
        ept.limit_price,
        ept.status,
        ept.monitor_id,
        ept.brokerage_order_id,
        ept.brokerage_order_status,
        ept.filled_at,
        ept.filled_qty,
        ept.filled_price,
        ept.account_id,
        ept.notes,
        s.symbol,
        ep.side,
        b.name as basket_name
      FROM entry_plan_tranches ept
      JOIN entry_plans ep ON ept.plan_id = ep.id
      JOIN securities s ON ep.security_id = s.id
      JOIN rebalance_baskets b ON ep.basket_id = b.id
      WHERE ept.id = ?
    `).get(id) as any;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      planId: row.plan_id,
      trancheNumber: row.tranche_number,
      triggerType: row.trigger_type || 'price',
      triggerDate: row.trigger_date || null,
      triggerPrice: row.trigger_price || 0,
      shares: row.shares,
      limitPrice: row.limit_price || null,
      status: row.status,
      monitorId: row.monitor_id || null,
      brokerageOrderId: row.brokerage_order_id || null,
      brokerageOrderStatus: row.brokerage_order_status || null,
      filledAt: row.filled_at || null,
      filledQty: row.filled_qty || null,
      filledPrice: row.filled_price || null,
      accountId: row.account_id || null,
      notes: row.notes || null,
      symbol: row.symbol,
      side: row.side || 'buy',
      basketName: row.basket_name,
    };
  }
}
