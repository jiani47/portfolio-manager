import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedPortfolio } from '../../../shared/repositories/__tests__/fixture';
import { run, type WatchlistResult } from '../watchlist';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  seedPortfolio(db);
});

describe('watchlist CLI command', () => {
  describe('list', () => {
    it('returns all watchlists with item counts', () => {
      const result = run([], db) as WatchlistResult;

      expect(result.command).toBe('list');
      expect(Array.isArray(result.data)).toBe(true);

      const lists = result.data as any[];
      expect(lists).toHaveLength(2);

      const growth = lists.find(l => l.name === 'High Growth');
      expect(growth?.itemCount).toBe(2);
      expect(growth?.description).toBe('High growth potential tech stocks');
    });

    it('also accepts explicit "list" subcommand', () => {
      const result = run(['list'], db) as WatchlistResult;

      expect(result.command).toBe('list');
      expect(Array.isArray(result.data)).toBe(true);
    });
  });

  describe('show', () => {
    it('returns watchlist with items and prices', () => {
      const result = run(['show', 'High Growth'], db) as WatchlistResult;

      expect(result.command).toBe('show');
      const watchlist = result.data as any;

      expect(watchlist.name).toBe('High Growth');
      expect(watchlist.items).toHaveLength(2);

      const nvda = watchlist.items.find((i: any) => i.symbol === 'NVDA');
      expect(nvda.price).toBe(150);
      expect(nvda.targetEntryPrice).toBe(140);
      expect(nvda.vsTargetPct).toBeCloseTo(7.14, 1);
    });

    it('throws error for non-existent watchlist', () => {
      expect(() => {
        run(['show', 'Does Not Exist'], db);
      }).toThrow('Watchlist not found: Does Not Exist');
    });

    it('requires watchlist name argument', () => {
      expect(() => {
        run(['show'], db);
      }).toThrow('Usage: watchlist show <name>');
    });
  });

  describe('create', () => {
    it('creates new watchlist with description', () => {
      const result = run(['create', 'Tech Leaders', 'Top tech companies'], db) as WatchlistResult;

      expect(result.command).toBe('create');
      expect(result.data).toMatchObject({ message: 'Created watchlist: Tech Leaders' });

      // Verify it was created
      const row = db.prepare('SELECT * FROM watchlists WHERE name = ?').get('Tech Leaders') as any;
      expect(row).toBeDefined();
      expect(row.description).toBe('Top tech companies');
    });

    it('creates watchlist without description', () => {
      const result = run(['create', 'My List'], db) as WatchlistResult;

      expect(result.command).toBe('create');
      expect(result.data).toMatchObject({ message: 'Created watchlist: My List' });

      const row = db.prepare('SELECT * FROM watchlists WHERE name = ?').get('My List') as any;
      expect(row.description).toBeNull();
    });

    it('throws error for duplicate watchlist name', () => {
      expect(() => {
        run(['create', 'High Growth'], db);
      }).toThrow('Watchlist already exists: High Growth');
    });

    it('requires watchlist name argument', () => {
      expect(() => {
        run(['create'], db);
      }).toThrow('Usage: watchlist create <name>');
    });
  });

  describe('add', () => {
    it('adds item with target and thesis to existing watchlist', () => {
      const result = run(['add', 'High Growth', 'AAPL', '180', 'Services revenue growth'], db) as WatchlistResult;

      expect(result.command).toBe('add');
      expect(result.data).toMatchObject({ message: 'Added AAPL to High Growth (target: $180)' });

      // Verify in DB
      const item = db.prepare(
        'SELECT * FROM watchlist_items WHERE symbol = ? AND watchlist_id = (SELECT id FROM watchlists WHERE name = ?)'
      ).get('AAPL', 'High Growth') as any;

      expect(item).toBeDefined();
      expect(item.target_entry_price).toBe(180);
      expect(item.thesis_snippet).toBe('Services revenue growth');
    });

    it('adds item without target or thesis', () => {
      const result = run(['add', 'Value Plays', 'AMZN'], db) as WatchlistResult;

      expect(result.command).toBe('add');
      expect(result.data).toMatchObject({ message: 'Added AMZN to Value Plays' });

      const item = db.prepare(
        'SELECT * FROM watchlist_items WHERE symbol = ? AND watchlist_id = (SELECT id FROM watchlists WHERE name = ?)'
      ).get('AMZN', 'Value Plays') as any;

      expect(item.target_entry_price).toBeNull();
      expect(item.thesis_snippet).toBeNull();
    });

    it('creates watchlist if it does not exist', () => {
      const result = run(['add', 'New List', 'MSFT', '350'], db) as WatchlistResult;

      expect(result.command).toBe('add');

      // Verify watchlist was created
      const watchlist = db.prepare('SELECT * FROM watchlists WHERE name = ?').get('New List') as any;
      expect(watchlist).toBeDefined();

      // Verify item was added
      const item = db.prepare(
        'SELECT * FROM watchlist_items WHERE symbol = ? AND watchlist_id = ?'
      ).get('MSFT', watchlist.id) as any;
      expect(item).toBeDefined();
    });

    it('creates security if it does not exist', () => {
      const result = run(['add', 'High Growth', 'TSLA', '250'], db) as WatchlistResult;

      expect(result.command).toBe('add');

      // Verify security was created
      const security = db.prepare('SELECT * FROM securities WHERE symbol = ?').get('TSLA') as any;
      expect(security).toBeDefined();
      expect(security.type).toBe('stock');
    });

    it('updates existing item (upsert)', () => {
      // Add initial item
      run(['add', 'High Growth', 'NVDA', '130', 'Old thesis'], db);

      // Update with new target and thesis
      const result = run(['add', 'High Growth', 'NVDA', '155', 'New AI chips'], db) as WatchlistResult;

      expect(result.command).toBe('add');

      // Verify only one item exists with updated values
      const items = db.prepare(
        'SELECT * FROM watchlist_items WHERE symbol = ? AND watchlist_id = (SELECT id FROM watchlists WHERE name = ?)'
      ).all('NVDA', 'High Growth') as any[];

      expect(items).toHaveLength(1);
      expect(items[0].target_entry_price).toBe(155);
      expect(items[0].thesis_snippet).toBe('New AI chips');
    });

    it('converts symbol to uppercase', () => {
      run(['add', 'High Growth', 'aapl'], db);

      const item = db.prepare(
        'SELECT * FROM watchlist_items WHERE symbol = ? AND watchlist_id = (SELECT id FROM watchlists WHERE name = ?)'
      ).get('AAPL', 'High Growth') as any;

      expect(item).toBeDefined();
    });

    it('requires watchlist name and symbol arguments', () => {
      expect(() => run(['add'], db)).toThrow('Usage:');
      expect(() => run(['add', 'High Growth'], db)).toThrow('Usage:');
    });
  });

  describe('remove', () => {
    it('removes item from watchlist', () => {
      const result = run(['remove', 'High Growth', 'NVDA'], db) as WatchlistResult;

      expect(result.command).toBe('remove');
      expect(result.data).toMatchObject({ message: 'Removed NVDA from High Growth' });

      // Verify item was removed
      const item = db.prepare(
        'SELECT * FROM watchlist_items WHERE symbol = ? AND watchlist_id = (SELECT id FROM watchlists WHERE name = ?)'
      ).get('NVDA', 'High Growth') as any;

      expect(item).toBeUndefined();
    });

    it('converts symbol to uppercase', () => {
      const result = run(['remove', 'High Growth', 'nvda'], db) as WatchlistResult;

      expect(result.command).toBe('remove');
      expect(result.data).toMatchObject({ message: 'Removed NVDA from High Growth' });
    });

    it('throws error for non-existent item', () => {
      expect(() => {
        run(['remove', 'High Growth', 'AAPL'], db);
      }).toThrow('AAPL not found in High Growth');
    });

    it('requires watchlist name and symbol arguments', () => {
      expect(() => run(['remove'], db)).toThrow('Usage:');
      expect(() => run(['remove', 'High Growth'], db)).toThrow('Usage:');
    });
  });

  describe('delete', () => {
    it('deletes watchlist and all items (CASCADE)', () => {
      const result = run(['delete', 'High Growth'], db) as WatchlistResult;

      expect(result.command).toBe('delete');
      expect(result.data).toMatchObject({ message: 'Deleted watchlist: High Growth' });

      // Verify watchlist was deleted
      const watchlist = db.prepare('SELECT * FROM watchlists WHERE name = ?').get('High Growth') as any;
      expect(watchlist).toBeUndefined();

      // Verify items were CASCADE deleted
      const items = db.prepare(
        'SELECT * FROM watchlist_items WHERE symbol IN (?, ?)'
      ).all('NVDA', 'META') as any[];
      expect(items.filter((i: any) => i.watchlist_id === 'wl-growth')).toHaveLength(0);
    });

    it('throws error for non-existent watchlist', () => {
      expect(() => {
        run(['delete', 'Does Not Exist'], db);
      }).toThrow('Watchlist not found: Does Not Exist');
    });

    it('requires watchlist name argument', () => {
      expect(() => {
        run(['delete'], db);
      }).toThrow('Usage: watchlist delete <name>');
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
