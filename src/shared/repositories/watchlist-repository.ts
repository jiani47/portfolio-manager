/**
 * WatchlistRepository — typed DB queries for watchlists with items, prices, and targets.
 * All SQL lives here. Consumers get typed objects, never raw rows.
 */
import type Database from 'better-sqlite3';

interface WatchlistWithCountRow {
  id: string;
  name: string;
  description: string | null;
  item_count: number;
}

export interface WatchlistSummary {
  id: string;
  name: string;
  description?: string;
  itemCount: number;
}

interface WatchlistItemWithPriceRow {
  symbol: string;
  price: number | null;
  target_entry_price: number | null;
  target_exit_price: number | null;
  thesis_snippet: string | null;
  notes: string | null;
}

export interface WatchlistItemWithPrice {
  symbol: string;
  price?: number;
  targetEntryPrice?: number;
  targetExitPrice?: number;
  thesisSnippet?: string;
  notes?: string;
  vsTargetPct?: number;  // (price - target) / target * 100
}

export interface WatchlistWithItems {
  id: string;
  name: string;
  description?: string;
  items: WatchlistItemWithPrice[];
}

export class WatchlistRepository {
  constructor(private db: Database.Database) {}

  /**
   * Get all watchlists with item counts.
   * Used by "watchlists" CLI command.
   */
  getAllWithItemCounts(): WatchlistSummary[] {
    const rows = this.db.prepare(`
      SELECT
        w.id,
        w.name,
        w.description,
        COUNT(wi.id) as item_count
      FROM watchlists w
      LEFT JOIN watchlist_items wi ON wi.watchlist_id = w.id
      GROUP BY w.id
      ORDER BY w.name
    `).all() as WatchlistWithCountRow[];

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description ?? undefined,
      itemCount: r.item_count,
    }));
  }

  /**
   * Get watchlist by name with all items and latest prices.
   * Used by "watchlist <name>" CLI command.
   * Returns null if watchlist not found.
   */
  getByNameWithItems(name: string): WatchlistWithItems | null {
    // First, get the watchlist
    const watchlist = this.db.prepare(`
      SELECT id, name, description
      FROM watchlists
      WHERE name = ?
    `).get(name) as { id: string; name: string; description: string | null } | undefined;

    if (!watchlist) return null;

    // Get latest price date
    const latestDateRow = this.db.prepare(`
      SELECT MAX(date) as max_date FROM price_history
    `).get() as { max_date: string | null };
    const latestDate = latestDateRow?.max_date;

    // Get items with prices
    const itemRows = this.db.prepare(`
      SELECT
        wi.symbol,
        ph.close_price as price,
        wi.target_entry_price,
        wi.target_exit_price,
        wi.thesis_snippet,
        wi.notes
      FROM watchlist_items wi
      LEFT JOIN securities s ON wi.security_id = s.id
      LEFT JOIN price_history ph ON ph.security_id = s.id AND ph.date = ?
      WHERE wi.watchlist_id = ?
      ORDER BY wi.symbol
    `).all(latestDate, watchlist.id) as WatchlistItemWithPriceRow[];

    const items: WatchlistItemWithPrice[] = itemRows.map(r => {
      const item: WatchlistItemWithPrice = {
        symbol: r.symbol,
      };

      if (r.price != null) item.price = r.price;
      if (r.target_entry_price != null) item.targetEntryPrice = r.target_entry_price;
      if (r.target_exit_price != null) item.targetExitPrice = r.target_exit_price;
      if (r.thesis_snippet) item.thesisSnippet = r.thesis_snippet;
      if (r.notes) item.notes = r.notes;

      // Calculate vs target percentage
      if (r.price != null && r.target_entry_price != null) {
        item.vsTargetPct = ((r.price - r.target_entry_price) / r.target_entry_price) * 100;
      }

      return item;
    });

    return {
      id: watchlist.id,
      name: watchlist.name,
      description: watchlist.description ?? undefined,
      items,
    };
  }

  /**
   * Get all symbols across all watchlists (deduplicated).
   * Useful for quick checks.
   */
  getAllSymbols(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT symbol
      FROM watchlist_items
      ORDER BY symbol
    `).all() as { symbol: string }[];

    return rows.map(r => r.symbol);
  }
}
