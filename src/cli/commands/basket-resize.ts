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

  // Get distinct symbol+side combos with any non-filled tranches
  const symbolSides = db.prepare(`
    SELECT DISTINCT s.symbol, ep.side
    FROM entry_plans ep
    JOIN securities s ON ep.security_id = s.id
    JOIN entry_plan_tranches ept ON ept.plan_id = ep.id
    WHERE ep.basket_id = ? AND ep.status = 'active'
      AND ept.status IN ('pending', 'triggered')
    ORDER BY ep.side, s.symbol
  `).all(basketId) as SymbolSideRow[];

  const resized: ResizedSymbol[] = [];
  const skipped: SkippedSymbol[] = [];

  const cancelStmt = db.prepare(
    `UPDATE entry_plan_tranches SET status = 'cancelled' WHERE id = ?`
  );
  const insertStmt = db.prepare(`
    INSERT INTO entry_plan_tranches (id, plan_id, tranche_number, trigger_price, shares, status, trigger_type, trigger_date)
    VALUES (?, ?, ?, 0, ?, 'pending', 'date', ?)
  `);

  for (const ss of symbolSides) {
    const { symbol, side } = ss;

    // Get ALL pending/triggered tranches across all plans
    const tranches = db.prepare(`
      SELECT ept.id, ept.tranche_number, ept.shares, ept.status, ept.plan_id
      FROM entry_plan_tranches ept
      JOIN entry_plans ep ON ept.plan_id = ep.id
      JOIN securities s ON ep.security_id = s.id
      WHERE ep.basket_id = ? AND s.symbol = ? AND ep.side = ? AND ep.status = 'active'
        AND ept.status IN ('pending', 'triggered')
      ORDER BY ept.tranche_number
    `).all(basketId, symbol, side) as TrancheRow[];

    if (tranches.length === 0) continue;

    // Get the first plan ID (we'll create new tranches on this plan)
    const firstPlanId = tranches[0].plan_id;
    const oldTotal = tranches.reduce((s, t) => s + t.shares, 0);

    // Current position quantity
    const posRow = db.prepare(`
      SELECT SUM(p.quantity) as qty FROM positions p
      JOIN securities s ON p.security_id = s.id
      WHERE s.symbol = ? AND s.type NOT IN ('cash', 'option') AND p.quantity > 0
    `).get(symbol) as { qty: number | null };
    const currentQty = Math.floor(posRow?.qty ?? 0);

    // Target allocation %
    const intentRow = db.prepare(`
      SELECT pi.target_allocation_pct FROM position_intents pi
      JOIN positions p ON pi.position_id = p.id
      JOIN securities s ON p.security_id = s.id
      WHERE s.symbol = ? AND pi.target_allocation_pct IS NOT NULL LIMIT 1
    `).get(symbol) as { target_allocation_pct: number } | undefined;

    if (!intentRow) {
      skipped.push({ symbol, side, reason: 'no target allocation set' });
      continue;
    }
    const targetPct = intentRow.target_allocation_pct;

    // Latest close price
    const priceRow = db.prepare(`
      SELECT ph.close_price FROM price_history ph
      JOIN securities s ON ph.security_id = s.id
      WHERE s.symbol = ? ORDER BY ph.date DESC LIMIT 1
    `).get(symbol) as { close_price: number } | undefined;

    if (!priceRow || priceRow.close_price <= 0) {
      skipped.push({ symbol, side, reason: 'no price data' });
      continue;
    }
    const price = priceRow.close_price;

    const targetMv = portfolioTotal * targetPct / 100;
    const targetQty = Math.floor(targetMv / price);

    const totalNeed = side === 'sell'
      ? Math.max(0, currentQty - targetQty)
      : Math.max(0, targetQty - currentQty);

    // Subtract already-filled shares
    const filledRow = db.prepare(`
      SELECT SUM(COALESCE(ept.filled_qty, 0)) as filled
      FROM entry_plan_tranches ept
      JOIN entry_plans ep ON ept.plan_id = ep.id
      JOIN securities s ON ep.security_id = s.id
      WHERE ep.basket_id = ? AND s.symbol = ? AND ep.side = ? AND ept.status = 'filled'
    `).get(basketId, symbol, side) as { filled: number | null };
    const alreadyFilled = Math.floor(filledRow?.filled ?? 0);

    const remainingNeed = Math.max(0, totalNeed - alreadyFilled);

    // Step 1: Cancel ALL existing pending/triggered tranches
    for (const t of tranches) {
      cancelStmt.run(t.id);
    }

    // Step 2: If no remaining need, we're done (all cancelled)
    if (remainingNeed === 0) {
      resized.push({
        symbol, side, action: 'cancelled',
        oldTotal, newTotal: 0, targetPct, targetMv, currentQty, price,
        tranches: tranches.map(t => ({
          trancheId: t.id, trancheNumber: t.tranche_number,
          oldShares: t.shares, newShares: 0,
        })),
      });
      continue;
    }

    // Step 3: Create fresh weekly tranches
    const numTranches = Math.min(DEFAULT_NUM_TRANCHES, remainingNeed); // don't create more tranches than shares
    const perTranche = Math.floor(remainingNeed / numTranches);
    const remainder = remainingNeed % numTranches;
    const dates = getWeeklyDates(numTranches);

    const newTranches: ResizedTranche[] = [];
    for (let i = 0; i < numTranches; i++) {
      const shares = i < numTranches - 1 ? perTranche : perTranche + remainder;
      const id = uuidv4();
      insertStmt.run(id, firstPlanId, i + 1, shares, dates[i]);
      newTranches.push({
        trancheId: id,
        trancheNumber: i + 1,
        oldShares: 0,
        newShares: shares,
        triggerDate: dates[i],
      });
    }

    resized.push({
      symbol, side, action: 'resized',
      oldTotal, newTotal: remainingNeed, targetPct, targetMv, currentQty, price,
      tranches: newTranches,
    });
  }

  return { basketName, portfolioTotal, resized, skipped };
}
