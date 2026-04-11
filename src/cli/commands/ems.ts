/**
 * CLI EMS commands — Execution Management System for basket orders.
 * Subcommands: baskets, basket, basket-create, basket-orders, basket-fills, basket-status
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { EMSRepository, type BasketSummary, type BasketDetail, type TriggeredOrder, type FillRecord } from '../../shared/repositories/ems-repository';

type EMSCommand = 'baskets' | 'basket' | 'basket-create' | 'basket-orders' | 'basket-fills' | 'basket-status';

export interface EMSResult {
  command: EMSCommand;
  data?: BasketSummary[] | BasketDetail | { message: string; basketId?: string } | TriggeredOrder[] | FillRecord[] | {
    totalBaskets: number;
    activeBaskets: number;
    totalTranches: number;
    pending: number;
    triggered: number;
    submitted: number;
    filled: number;
  };
}

export function run(args: string[], db: Database.Database): EMSResult {
  const subcommand = args[0] as EMSCommand | undefined;

  if (!subcommand || subcommand === 'baskets') {
    return listBaskets(db);
  }

  switch (subcommand) {
    case 'basket':
      return showBasket(args.slice(1), db);
    case 'basket-create':
      return createBasket(args.slice(1), db);
    case 'basket-orders':
      return listOrders(args.slice(1), db);
    case 'basket-fills':
      return listFills(args.slice(1), db);
    case 'basket-status':
      return getStatus(db);
    default:
      throw new Error(`Unknown subcommand: ${subcommand}. Use: baskets, basket, basket-create, basket-orders, basket-fills, basket-status`);
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
    INSERT INTO rebalance_baskets (id, name, status, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, 'active', notes || null, now, now);

  const message = `Basket created: ${name} (id: ${id})`;
  return { command: 'basket-create', data: { message, basketId: id } };
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
