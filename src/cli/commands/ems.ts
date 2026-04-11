/**
 * CLI EMS commands — Execution Management System for basket orders.
 * All database operations and business logic in TypeScript.
 * Shell script only handles argument parsing and output formatting.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { EMSRepository, type BasketSummary, type BasketDetail, type TriggeredOrder, type FillRecord } from '../../shared/repositories/ems-repository';

type EMSCommand =
  | 'baskets'
  | 'basket'
  | 'basket-create'
  | 'basket-add'
  | 'basket-orders'
  | 'basket-fills'
  | 'basket-status'
  | 'basket-cancel'
  | 'basket-fill';

export interface EMSResult {
  command: string;
  data?: any;
  error?: string;
}

export interface BasketAddOptions {
  basket: string;
  side: 'buy' | 'sell';
  symbol: string;
  totalShares: number;
  numTranches: number;
  triggerType: 'date' | 'price';
  triggerValues: string; // comma-separated
  invalidation?: string;
  invalidationSymbol?: string;
  invalidationDir?: 'above' | 'below';
  invalidationPrice?: number;
  accountSuffix?: string;
}

export interface BasketFillOptions {
  trancheId: string;
  fillQty: number;
  fillPrice: number;
}

export function run(args: string[], db: Database.Database): EMSResult {
  const subcommand = args[0] as EMSCommand | undefined;

  try {
    if (!subcommand || subcommand === 'baskets') {
      return listBaskets(db);
    }

    switch (subcommand) {
      case 'basket':
        return showBasket(args.slice(1), db);
      case 'basket-create':
        return createBasket(args.slice(1), db);
      case 'basket-add':
        return addToBasket(args.slice(1), db);
      case 'basket-orders':
        return listOrders(args.slice(1), db);
      case 'basket-fills':
        return listFills(args.slice(1), db);
      case 'basket-status':
        return getStatus(db);
      case 'basket-cancel':
        return cancelTranche(args.slice(1), db);
      case 'basket-fill':
        return fillTranche(args.slice(1), db);
      default:
        throw new Error(`Unknown subcommand: ${subcommand}`);
    }
  } catch (error) {
    return {
      command: subcommand || 'unknown',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function listBaskets(db: Database.Database): EMSResult {
  const repo = new EMSRepository(db);
  const baskets = repo.getAllBaskets();
  return { command: 'baskets', data: baskets };
}

function showBasket(args: string[], db: Database.Database): EMSResult {
  const name = args[0];
  if (!name) {
    throw new Error('Usage: ems basket <name>');
  }

  const repo = new EMSRepository(db);
  const basket = repo.getBasketByName(name);

  if (!basket) {
    throw new Error(`Basket not found: ${name}`);
  }

  return { command: 'basket', data: basket };
}

function createBasket(args: string[], db: Database.Database): EMSResult {
  const [name, notes] = args;

  if (!name) {
    throw new Error('Usage: ems basket-create <name> [notes]');
  }

  // Check if basket already exists
  const existing = db.prepare('SELECT id FROM rebalance_baskets WHERE name = ?').get(name) as { id: string } | undefined;

  if (existing) {
    throw new Error(`Basket already exists: ${name} (id: ${existing.id})`);
  }

  const now = new Date().toISOString();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO rebalance_baskets (id, name, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, 'active', now, now);

  const message = `Basket created: ${name} (id: ${id})`;
  return { command: 'basket-create', data: { message, basketId: id } };
}

function addToBasket(args: string[], db: Database.Database): EMSResult {
  // Parse positional args: basket side symbol totalShares numTranches triggerType triggerValues
  if (args.length < 7) {
    throw new Error('Usage: ems basket-add <basket> <buy|sell> <symbol> <totalShares> <numTranches> <date|price> <triggerValues> [--invalidation <text>] [--invalidation-price <sym> <dir> <price>] [--account <suffix>]');
  }

  const [basket, sideRaw, symbolRaw, totalSharesStr, numTranchesStr, triggerTypeRaw, triggerValues, ...flags] = args;

  const side = sideRaw.toLowerCase() as 'buy' | 'sell';
  const symbol = symbolRaw.toUpperCase();
  const totalShares = parseInt(totalSharesStr, 10);
  const numTranches = parseInt(numTranchesStr, 10);
  const triggerType = triggerTypeRaw.toLowerCase() as 'date' | 'price';

  // Parse flags
  let invalidation: string | undefined;
  let invalidationSymbol: string | undefined;
  let invalidationDir: 'above' | 'below' | undefined;
  let invalidationPrice: number | undefined;
  let accountSuffix: string | undefined;

  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--invalidation' && i + 1 < flags.length) {
      invalidation = flags[++i];
    } else if (flags[i] === '--invalidation-price' && i + 3 < flags.length) {
      invalidationSymbol = flags[++i].toUpperCase();
      invalidationDir = flags[++i] as 'above' | 'below';
      invalidationPrice = parseFloat(flags[++i]);
    } else if (flags[i] === '--account' && i + 1 < flags.length) {
      accountSuffix = flags[++i];
    }
  }

  // Validate inputs
  if (side !== 'buy' && side !== 'sell') {
    throw new Error(`Invalid side: ${side}. Must be 'buy' or 'sell'`);
  }
  if (triggerType !== 'date' && triggerType !== 'price') {
    throw new Error(`Invalid trigger type: ${triggerType}. Must be 'date' or 'price'`);
  }
  if (isNaN(totalShares) || totalShares <= 0) {
    throw new Error(`Invalid totalShares: ${totalSharesStr}`);
  }
  if (isNaN(numTranches) || numTranches <= 0) {
    throw new Error(`Invalid numTranches: ${numTranchesStr}`);
  }

  // Look up basket
  const basketRow = db.prepare('SELECT id FROM rebalance_baskets WHERE name = ? AND status = ?')
    .get(basket, 'active') as { id: string } | undefined;
  if (!basketRow) {
    throw new Error(`Active basket not found: ${basket}`);
  }
  const basketId = basketRow.id;

  // Look up security
  const securityRow = db.prepare('SELECT id FROM securities WHERE symbol = ?').get(symbol) as { id: string } | undefined;
  if (!securityRow) {
    throw new Error(`Security not found: ${symbol}`);
  }
  const securityId = securityRow.id;

  // Look up account if provided
  let accountId: string | null = null;
  if (accountSuffix) {
    const accountRow = db.prepare("SELECT id FROM accounts WHERE account_number LIKE '%' || ?").get(accountSuffix) as { id: string } | undefined;
    if (!accountRow) {
      throw new Error(`No account ending in: ${accountSuffix}`);
    }
    accountId = accountRow.id;
  }

  // Parse trigger values
  const triggers = triggerValues.split(',');
  if (triggers.length !== 1 && triggers.length !== numTranches) {
    throw new Error(`Trigger values count (${triggers.length}) must be 1 or match numTranches (${numTranches})`);
  }

  // Calculate shares per tranche
  const sharesPerTranche = Math.floor(totalShares / numTranches);
  const remainder = totalShares % numTranches;

  const now = new Date().toISOString();
  const planId = randomUUID();

  // Create invalidation monitor if needed
  let invalidationMonitorId: string | null = null;
  if (invalidationSymbol && invalidationDir && invalidationPrice !== undefined) {
    invalidationMonitorId = randomUUID();
    db.prepare(`
      INSERT INTO monitors (id, symbol, direction, price_level, label, action_type, monitor_type, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      invalidationMonitorId,
      invalidationSymbol,
      invalidationDir,
      invalidationPrice,
      `EMS invalidation: ${symbol} ${side} plan`,
      'action_required',
      'price',
      'active',
      now,
      now
    );
  }

  // Create entry plan
  db.prepare(`
    INSERT INTO entry_plans (id, security_id, basket_id, side, invalidation_condition, invalidation_monitor_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(planId, securityId, basketId, side, invalidation || null, invalidationMonitorId, 'active', now, now);

  // Create tranches
  const createdTranches: any[] = [];
  for (let i = 1; i <= numTranches; i++) {
    const trancheId = randomUUID();
    const isLastTranche = i === numTranches;
    const shares = isLastTranche ? sharesPerTranche + remainder : sharesPerTranche;
    const trigger = triggers.length === 1 ? triggers[0] : triggers[i - 1];

    if (triggerType === 'date') {
      // Date-triggered tranche
      db.prepare(`
        INSERT INTO entry_plan_tranches (id, plan_id, tranche_number, trigger_type, trigger_date, trigger_price, shares, status, account_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(trancheId, planId, i, 'date', trigger, 0, shares, 'pending', accountId);

      createdTranches.push({ number: i, shares, trigger: { type: 'date', value: trigger } });
    } else {
      // Price-triggered tranche: create monitor
      const monitorId = randomUUID();
      const triggerPrice = parseFloat(trigger);
      const direction = side === 'buy' ? 'below' : 'above';

      db.prepare(`
        INSERT INTO monitors (id, symbol, direction, price_level, label, action_type, monitor_type, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        monitorId,
        symbol,
        direction,
        triggerPrice,
        `EMS ${side} ${symbol} T${i}: ${shares} shares @ $${triggerPrice}`,
        'action_required',
        'price',
        'active',
        now,
        now
      );

      db.prepare(`
        INSERT INTO entry_plan_tranches (id, plan_id, tranche_number, trigger_type, trigger_price, shares, status, monitor_id, account_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(trancheId, planId, i, 'price', triggerPrice, shares, 'pending', monitorId, accountId);

      createdTranches.push({ number: i, shares, trigger: { type: 'price', value: triggerPrice, direction } });
    }
  }

  return {
    command: 'basket-add',
    data: {
      message: `Added ${symbol} ${side} plan to basket ${basket}`,
      planId,
      symbol,
      side,
      totalShares,
      tranches: createdTranches,
      invalidation: invalidation || null,
    },
  };
}

function listOrders(args: string[], db: Database.Database): EMSResult {
  const basketName = args[0]; // optional filter

  const repo = new EMSRepository(db);
  const orders = repo.getTriggeredOrders(basketName);

  return { command: 'basket-orders', data: orders };
}

function listFills(args: string[], db: Database.Database): EMSResult {
  const basketName = args[0]; // optional filter

  const repo = new EMSRepository(db);
  const fills = repo.getFills(basketName);

  return { command: 'basket-fills', data: fills };
}

function getStatus(db: Database.Database): EMSResult {
  const repo = new EMSRepository(db);
  const summary = repo.getStatusSummary();

  return { command: 'basket-status', data: summary };
}

function cancelTranche(args: string[], db: Database.Database): EMSResult {
  const [tranchePrefix] = args;

  if (!tranchePrefix) {
    throw new Error('Usage: ems basket-cancel <tranche_id_prefix>');
  }

  // Find tranche by prefix
  const tranche = db.prepare(`
    SELECT ept.id, ept.status, ept.brokerage_order_id, s.symbol, ep.side, ept.shares
    FROM entry_plan_tranches ept
    JOIN entry_plans ep ON ept.plan_id = ep.id
    JOIN securities s ON ep.security_id = s.id
    WHERE ept.id LIKE ? || '%'
  `).get(tranchePrefix) as any;

  if (!tranche) {
    throw new Error(`Tranche not found with prefix: ${tranchePrefix}`);
  }

  if (tranche.status === 'filled') {
    throw new Error(`Cannot cancel filled tranche: ${tranche.id}`);
  }

  // Update tranche status to cancelled
  db.prepare('UPDATE entry_plan_tranches SET status = ? WHERE id = ?').run('cancelled', tranche.id);

  return {
    command: 'basket-cancel',
    data: {
      message: `Cancelled tranche: ${tranche.symbol} ${tranche.side} ${tranche.shares} shares`,
      trancheId: tranche.id,
      note: tranche.brokerage_order_id
        ? `Note: Brokerage order ${tranche.brokerage_order_id} must be cancelled separately via broker`
        : null,
    },
  };
}

function fillTranche(args: string[], db: Database.Database): EMSResult {
  const [tranchePrefix, fillQtyStr, fillPriceStr] = args;

  if (!tranchePrefix || !fillQtyStr || !fillPriceStr) {
    throw new Error('Usage: ems basket-fill <tranche_id_prefix> <fillQty> <fillPrice>');
  }

  const fillQty = parseFloat(fillQtyStr);
  const fillPrice = parseFloat(fillPriceStr);

  if (isNaN(fillQty) || fillQty <= 0) {
    throw new Error(`Invalid fillQty: ${fillQtyStr}`);
  }
  if (isNaN(fillPrice) || fillPrice <= 0) {
    throw new Error(`Invalid fillPrice: ${fillPriceStr}`);
  }

  // Find tranche
  const tranche = db.prepare(`
    SELECT ept.id, ept.status, ept.shares, ept.filled_qty, ept.filled_price, s.symbol, ep.side
    FROM entry_plan_tranches ept
    JOIN entry_plans ep ON ept.plan_id = ep.id
    JOIN securities s ON ep.security_id = s.id
    WHERE ept.id LIKE ? || '%'
  `).get(tranchePrefix) as any;

  if (!tranche) {
    throw new Error(`Tranche not found with prefix: ${tranchePrefix}`);
  }

  // Validate status
  if (!['pending', 'triggered', 'submitted', 'filled'].includes(tranche.status)) {
    throw new Error(`Cannot fill tranche with status: ${tranche.status}`);
  }

  const oldFilledQty = tranche.filled_qty || 0;
  const oldFilledPrice = tranche.filled_price || 0;
  const totalShares = tranche.shares;

  // Calculate new filled quantity
  const newFilledQty = oldFilledQty + fillQty;

  if (newFilledQty > totalShares) {
    throw new Error(`Fill quantity ${fillQty} would exceed total shares ${totalShares} (already filled: ${oldFilledQty})`);
  }

  // Calculate weighted average price
  let newFilledPrice: number;
  if (oldFilledQty === 0) {
    newFilledPrice = fillPrice;
  } else {
    newFilledPrice = (oldFilledQty * oldFilledPrice + fillQty * fillPrice) / newFilledQty;
  }

  // Determine new status
  const isFullyFilled = newFilledQty >= totalShares;
  const newStatus = isFullyFilled ? 'filled' : (tranche.status === 'pending' ? 'triggered' : tranche.status);
  const brokerageStatus = isFullyFilled ? 'FILLED' : 'PARTIAL';

  const now = new Date().toISOString();

  // Update tranche
  db.prepare(`
    UPDATE entry_plan_tranches
    SET filled_qty = ?,
        filled_price = ?,
        filled_at = ?,
        status = ?,
        brokerage_order_status = ?
    WHERE id = ?
  `).run(newFilledQty, newFilledPrice, now, newStatus, brokerageStatus, tranche.id);

  return {
    command: 'basket-fill',
    data: {
      message: `${tranche.symbol}: filled ${fillQty} @ $${fillPrice.toFixed(2)} (${newFilledQty}/${totalShares}, ${newStatus})`,
      trancheId: tranche.id,
      symbol: tranche.symbol,
      side: tranche.side,
      fillQty,
      fillPrice,
      totalFilled: newFilledQty,
      totalShares,
      avgPrice: newFilledPrice,
      status: newStatus,
    },
  };
}
