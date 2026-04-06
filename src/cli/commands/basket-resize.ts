/**
 * CLI basket-resize command — recalculate all pending tranche quantities
 * to match target allocation percentages at current prices.
 *
 * Approach: for each symbol+side, cancel ALL pending/triggered tranches,
 * recalculate total need, then create fresh evenly-distributed weekly
 * tranches on the first active plan.
 *
 * Reads close prices from price_history (no pre/post-market).
 * Requires --rw flag (mutates DB).
 */
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

const DEFAULT_NUM_TRANCHES = 6; // weekly over 6 weeks

export interface ResizedTranche {
  trancheId: string;
  trancheNumber: number;
  oldShares: number;
  newShares: number;
  triggerDate?: string;
}

export interface ResizedSymbol {
  symbol: string;
  side: string;
  action: 'resized' | 'cancelled' | 'unchanged';
  oldTotal: number;
  newTotal: number;
  targetPct: number;
  targetMv: number;
  currentQty: number;
  price: number;
  tranches: ResizedTranche[];
}

export interface SkippedSymbol {
  symbol: string;
  side: string;
  reason: string;
}

export interface BasketResizeResult {
  basketName: string;
  portfolioTotal: number;
  resized: ResizedSymbol[];
  skipped: SkippedSymbol[];
}

function getPortfolioTotal(db: Database.Database): number {
  const row = db.prepare(`
    SELECT SUM(p.quantity * COALESCE(
      (SELECT ph.close_price FROM price_history ph
       WHERE ph.security_id = p.security_id ORDER BY ph.date DESC LIMIT 1), 0
    )) as total
    FROM positions p
    JOIN securities s ON p.security_id = s.id
    WHERE s.type NOT IN ('cash', 'option') AND p.quantity > 0
  `).get() as { total: number | null };

  const cashRow = db.prepare(`
    SELECT SUM(p.quantity) as cash
    FROM positions p
    JOIN securities s ON p.security_id = s.id
    WHERE s.type = 'cash' AND p.quantity > 0
  `).get() as { cash: number | null };

  return (row?.total ?? 0) + (cashRow?.cash ?? 0);
}

/** Get next N Mondays starting from next week */
function getWeeklyDates(n: number): string[] {
  const dates: string[] = [];
  const today = new Date();
  // Find next Monday
  const dayOfWeek = today.getDay();
  const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek);
  const nextMonday = new Date(today);
  nextMonday.setDate(today.getDate() + daysUntilMonday);

  for (let i = 0; i < n; i++) {
    const d = new Date(nextMonday);
    d.setDate(nextMonday.getDate() + i * 7);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

interface SymbolSideRow { symbol: string; side: string }
interface TrancheRow {
  id: string;
  tranche_number: number;
  shares: number;
  status: string;
  plan_id: string;
}

export function run(args: string[], db: Database.Database): BasketResizeResult {
  const basketName = args[0];
  if (!basketName) throw new Error('Usage: basket-resize <basket_name>');

  const basket = db.prepare(
    `SELECT id FROM rebalance_baskets WHERE name = ?`
  ).get(basketName) as { id: string } | undefined;

  if (!basket) throw new Error(`Basket '${basketName}' not found`);
  const basketId = basket.id;

  const portfolioTotal = getPortfolioTotal(db);
  if (portfolioTotal <= 0) throw new Error('Portfolio total is zero — run refresh first');

  // Get all positions with target allocations
  interface PositionWithTarget {
    symbol: string;
    security_id: string;
    current_qty: number;
    target_pct: number;
    price: number;
  }

  const positionsWithTargets = db.prepare(`
    SELECT DISTINCT
      s.symbol,
      s.id as security_id,
      COALESCE((SELECT SUM(p2.quantity) FROM positions p2 WHERE p2.security_id = s.id AND p2.quantity > 0), 0) as current_qty,
      pi.target_allocation_pct as target_pct,
      COALESCE((SELECT ph.close_price FROM price_history ph WHERE ph.security_id = s.id ORDER BY ph.date DESC LIMIT 1), 0) as price
    FROM position_intents pi
    JOIN positions p ON pi.position_id = p.id
    JOIN securities s ON p.security_id = s.id
    WHERE pi.target_allocation_pct IS NOT NULL AND s.type NOT IN ('cash', 'option')
  `).all() as PositionWithTarget[];

  const resized: ResizedSymbol[] = [];
  const skipped: SkippedSymbol[] = [];

  const createPlanStmt = db.prepare(`
    INSERT INTO entry_plans (id, security_id, basket_id, side, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
  `);

  const cancelAllTranchesStmt = db.prepare(`
    UPDATE entry_plan_tranches
    SET status = 'cancelled'
    WHERE plan_id IN (
      SELECT ep.id FROM entry_plans ep
      JOIN securities s ON ep.security_id = s.id
      WHERE ep.basket_id = ? AND s.symbol = ? AND ep.side = ?
    )
  `);

  const insertTrancheStmt = db.prepare(`
    INSERT INTO entry_plan_tranches (id, plan_id, tranche_number, trigger_price, shares, status, trigger_type, trigger_date)
    VALUES (?, ?, ?, 0, ?, 'pending', 'date', ?)
  `);

  for (const pos of positionsWithTargets) {
    if (pos.price <= 0) {
      skipped.push({ symbol: pos.symbol, side: 'buy', reason: 'no price data' });
      continue;
    }

    const targetMv = portfolioTotal * pos.target_pct / 100;
    const targetQty = Math.floor(targetMv / pos.price);
    const currentQty = Math.floor(pos.current_qty);
    const delta = targetQty - currentQty;

    // Cancel ALL existing tranches for this symbol (both buy and sell)
    // This prevents orphaned opposite-side tranches from previous operations
    cancelAllTranchesStmt.run(basketId, pos.symbol, 'buy');
    cancelAllTranchesStmt.run(basketId, pos.symbol, 'sell');

    if (delta === 0) {
      // At target - no new tranches needed
      continue;
    }

    const side = delta > 0 ? 'buy' : 'sell';
    const needQty = Math.abs(delta);

    // Get or create plan for this symbol+side
    let planRow = db.prepare(`
      SELECT ep.id FROM entry_plans ep
      JOIN securities s ON ep.security_id = s.id
      WHERE ep.basket_id = ? AND s.symbol = ? AND ep.side = ? AND ep.status = 'active'
      LIMIT 1
    `).get(basketId, pos.symbol, side) as { id: string } | undefined;

    let planId: string;
    if (!planRow) {
      // Create new plan
      planId = uuidv4();
      createPlanStmt.run(planId, pos.security_id, basketId, side);
    } else {
      planId = planRow.id;
    }

    // Create fresh tranches
    const numTranches = Math.min(DEFAULT_NUM_TRANCHES, needQty);
    const perTranche = Math.floor(needQty / numTranches);
    const remainder = needQty % numTranches;
    const dates = getWeeklyDates(numTranches);

    const newTranches: ResizedTranche[] = [];
    for (let i = 0; i < numTranches; i++) {
      const shares = i < numTranches - 1 ? perTranche : perTranche + remainder;
      const trancheId = uuidv4();
      insertTrancheStmt.run(trancheId, planId, i + 1, shares, dates[i]);
      newTranches.push({
        trancheId,
        trancheNumber: i + 1,
        oldShares: 0,
        newShares: shares,
        triggerDate: dates[i],
      });
    }

    resized.push({
      symbol: pos.symbol,
      side,
      action: 'resized',
      oldTotal: 0, // we cancelled everything
      newTotal: needQty,
      targetPct: pos.target_pct,
      targetMv,
      currentQty,
      price: pos.price,
      tranches: newTranches,
    });
  }

  return { basketName, portfolioTotal, resized, skipped };
}
