/**
 * CLI watchlist commands — manage watchlists and items.
 * Subcommands: list, show, add, remove, create, delete
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { WatchlistRepository, type WatchlistSummary, type WatchlistWithItems } from '../../shared/repositories/watchlist-repository';

type WatchlistCommand = 'list' | 'show' | 'add' | 'remove' | 'create' | 'delete';

export interface WatchlistResult {
  command: WatchlistCommand;
  data?: WatchlistSummary[] | WatchlistWithItems | { message: string };
}

export function run(args: string[], db: Database.Database): WatchlistResult {
  const subcommand = args[0] as WatchlistCommand | undefined;

  if (!subcommand || subcommand === 'list') {
    return listWatchlists(db);
  }

  switch (subcommand) {
    case 'show':
      return showWatchlist(args.slice(1), db);
    case 'add':
      return addItem(args.slice(1), db);
    case 'remove':
      return removeItem(args.slice(1), db);
    case 'create':
      return createWatchlist(args.slice(1), db);
    case 'delete':
      return deleteWatchlist(args.slice(1), db);
    default:
      throw new Error(`Unknown subcommand: ${subcommand}. Use: list, show, add, remove, create, delete`);
  }
}

function listWatchlists(db: Database.Database): WatchlistResult {
  const repo = new WatchlistRepository(db);
  const watchlists = repo.getAllWithItemCounts();
  return { command: 'list', data: watchlists };
}

function showWatchlist(args: string[], db: Database.Database): WatchlistResult {
  const name = args[0];
  if (!name) {
    throw new Error('Usage: watchlist show <name>');
  }

  const repo = new WatchlistRepository(db);
  const watchlist = repo.getByNameWithItems(name);

  if (!watchlist) {
    throw new Error(`Watchlist not found: ${name}`);
  }

  return { command: 'show', data: watchlist };
}

function addItem(args: string[], db: Database.Database): WatchlistResult {
  const [name, symbol, targetStr, thesis] = args;

  if (!name || !symbol) {
    throw new Error('Usage: watchlist add <name> <symbol> [target_entry] [thesis_snippet]');
  }

  const symbolUpper = symbol.toUpperCase();
  const target = targetStr ? parseFloat(targetStr) : null;
  const now = new Date().toISOString();

  // Get or create watchlist
  let watchlistId = db.prepare('SELECT id FROM watchlists WHERE name = ?').get(name) as { id: string } | undefined;

  if (!watchlistId) {
    watchlistId = { id: randomUUID() };
    db.prepare(
      'INSERT INTO watchlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run(watchlistId.id, name, now, now);
  }

  // Ensure security exists
  let securityId = db.prepare('SELECT id FROM securities WHERE symbol = ?').get(symbolUpper) as { id: string } | undefined;

  if (!securityId) {
    securityId = { id: randomUUID() };
    db.prepare(
      'INSERT INTO securities (id, symbol, name, type, currency, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(securityId.id, symbolUpper, symbolUpper, 'stock', 'USD', now);
  }

  // Upsert watchlist item
  const existingItem = db.prepare(
    'SELECT id FROM watchlist_items WHERE watchlist_id = ? AND symbol = ?'
  ).get(watchlistId.id, symbolUpper) as { id: string } | undefined;

  const itemId = existingItem?.id || randomUUID();
  const createdAt = existingItem ? db.prepare('SELECT created_at FROM watchlist_items WHERE id = ?').get(itemId) as { created_at: string } : { created_at: now };

  db.prepare(`
    INSERT OR REPLACE INTO watchlist_items
    (id, watchlist_id, symbol, security_id, target_entry_price, thesis_snippet, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    itemId,
    watchlistId.id,
    symbolUpper,
    securityId.id,
    target,
    thesis || null,
    createdAt.created_at,
    now
  );

  const message = `Added ${symbolUpper} to ${name}${target ? ` (target: $${target})` : ''}`;
  return { command: 'add', data: { message } };
}

function removeItem(args: string[], db: Database.Database): WatchlistResult {
  const [name, symbol] = args;

  if (!name || !symbol) {
    throw new Error('Usage: watchlist remove <name> <symbol>');
  }

  const symbolUpper = symbol.toUpperCase();

  const result = db.prepare(`
    DELETE FROM watchlist_items
    WHERE symbol = ?
      AND watchlist_id = (SELECT id FROM watchlists WHERE name = ?)
  `).run(symbolUpper, name);

  if (result.changes === 0) {
    throw new Error(`${symbolUpper} not found in ${name}`);
  }

  const message = `Removed ${symbolUpper} from ${name}`;
  return { command: 'remove', data: { message } };
}

function createWatchlist(args: string[], db: Database.Database): WatchlistResult {
  const [name, description] = args;

  if (!name) {
    throw new Error('Usage: watchlist create <name> [description]');
  }

  const now = new Date().toISOString();
  const id = randomUUID();

  try {
    db.prepare(
      'INSERT INTO watchlists (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, name, description || null, now, now);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      throw new Error(`Watchlist already exists: ${name}`);
    }
    throw err;
  }

  const message = `Created watchlist: ${name}`;
  return { command: 'create', data: { message } };
}

function deleteWatchlist(args: string[], db: Database.Database): WatchlistResult {
  const name = args[0];

  if (!name) {
    throw new Error('Usage: watchlist delete <name>');
  }

  const result = db.prepare('DELETE FROM watchlists WHERE name = ?').run(name);

  if (result.changes === 0) {
    throw new Error(`Watchlist not found: ${name}`);
  }

  const message = `Deleted watchlist: ${name}`;
  return { command: 'delete', data: { message } };
}
