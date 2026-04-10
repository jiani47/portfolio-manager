import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedPortfolio } from './fixture';
import { WatchlistRepository } from '../watchlist-repository';

let db: Database.Database;
let repo: WatchlistRepository;

beforeEach(() => {
  db = createTestDb();
  seedPortfolio(db);
  repo = new WatchlistRepository(db);
});

describe('WatchlistRepository', () => {
  describe('getAllWithItemCounts', () => {
    it('returns all watchlists with correct item counts', () => {
      const summaries = repo.getAllWithItemCounts();

      expect(summaries).toHaveLength(2);

      const growth = summaries.find(s => s.name === 'High Growth');
      const value = summaries.find(s => s.name === 'Value Plays');

      expect(growth).toBeDefined();
      expect(growth!.itemCount).toBe(2); // NVDA, META
      expect(growth!.description).toBe('High growth potential tech stocks');

      expect(value).toBeDefined();
      expect(value!.itemCount).toBe(2); // SOFI, PLTR
      expect(value!.description).toBe('Undervalued names for entry');
    });

    it('returns zero item count for empty watchlist', () => {
      // Create empty watchlist
      const now = new Date().toISOString();
      db.exec(`
        INSERT INTO watchlists (id, name, description, created_at, updated_at)
        VALUES ('wl-empty', 'Empty List', NULL, '${now}', '${now}')
      `);

      const summaries = repo.getAllWithItemCounts();
      const empty = summaries.find(s => s.name === 'Empty List');

      expect(empty).toBeDefined();
      expect(empty!.itemCount).toBe(0);
      expect(empty!.description).toBeUndefined();
    });

    it('sorts watchlists alphabetically by name', () => {
      const summaries = repo.getAllWithItemCounts();
      const names = summaries.map(s => s.name);

      expect(names).toEqual(['High Growth', 'Value Plays']);
    });
  });

  describe('getByNameWithItems', () => {
    it('returns watchlist with all items and prices', () => {
      const watchlist = repo.getByNameWithItems('High Growth');

      expect(watchlist).not.toBeNull();
      expect(watchlist!.name).toBe('High Growth');
      expect(watchlist!.description).toBe('High growth potential tech stocks');
      expect(watchlist!.items).toHaveLength(2);

      // Check NVDA item (has price)
      const nvda = watchlist!.items.find(i => i.symbol === 'NVDA');
      expect(nvda).toBeDefined();
      expect(nvda!.price).toBe(150); // from price_history
      expect(nvda!.targetEntryPrice).toBe(140);
      expect(nvda!.targetExitPrice).toBe(200);
      expect(nvda!.thesisSnippet).toBe('AI leader, strong demand');
      expect(nvda!.notes).toBe('Monitor for pullback');

      // Check META item (no price - security not in price_history)
      const meta = watchlist!.items.find(i => i.symbol === 'META');
      expect(meta).toBeDefined();
      expect(meta!.price).toBeUndefined();
      expect(meta!.targetEntryPrice).toBe(300);
      expect(meta!.targetExitPrice).toBeUndefined();
      expect(meta!.thesisSnippet).toBe('Reels growth + AI integration');
      expect(meta!.notes).toBe('AI + VR play');
    });

    it('calculates vsTargetPct when both price and target exist', () => {
      const watchlist = repo.getByNameWithItems('High Growth');
      const nvda = watchlist!.items.find(i => i.symbol === 'NVDA');

      expect(nvda!.vsTargetPct).toBeDefined();
      // Price: 150, Target: 140 → (150-140)/140*100 = 7.14%
      expect(nvda!.vsTargetPct).toBeCloseTo(7.14, 1);
    });

    it('does not calculate vsTargetPct when price is missing', () => {
      const watchlist = repo.getByNameWithItems('High Growth');
      const meta = watchlist!.items.find(i => i.symbol === 'META');

      expect(meta!.vsTargetPct).toBeUndefined();
    });

    it('does not calculate vsTargetPct when target is missing', () => {
      const watchlist = repo.getByNameWithItems('Value Plays');
      const pltr = watchlist!.items.find(i => i.symbol === 'PLTR');

      expect(pltr!.vsTargetPct).toBeUndefined();
    });

    it('handles items with no targets or thesis', () => {
      const watchlist = repo.getByNameWithItems('Value Plays');
      const pltr = watchlist!.items.find(i => i.symbol === 'PLTR');

      expect(pltr).toBeDefined();
      expect(pltr!.targetEntryPrice).toBeUndefined();
      expect(pltr!.targetExitPrice).toBeUndefined();
      expect(pltr!.notes).toBeUndefined();
      expect(pltr!.thesisSnippet).toBe('Gov contracts + AI adoption');
    });

    it('returns null for non-existent watchlist', () => {
      const watchlist = repo.getByNameWithItems('Does Not Exist');
      expect(watchlist).toBeNull();
    });

    it('returns empty items array for empty watchlist', () => {
      // Create empty watchlist
      const now = new Date().toISOString();
      db.exec(`
        INSERT INTO watchlists (id, name, description, created_at, updated_at)
        VALUES ('wl-empty', 'Empty List', NULL, '${now}', '${now}')
      `);

      const watchlist = repo.getByNameWithItems('Empty List');

      expect(watchlist).not.toBeNull();
      expect(watchlist!.items).toHaveLength(0);
    });

    it('sorts items alphabetically by symbol', () => {
      const watchlist = repo.getByNameWithItems('High Growth');
      const symbols = watchlist!.items.map(i => i.symbol);

      expect(symbols).toEqual(['META', 'NVDA']);
    });
  });

  describe('getAllSymbols', () => {
    it('returns all unique symbols across all watchlists', () => {
      const symbols = repo.getAllSymbols();

      expect(symbols).toHaveLength(4);
      expect(symbols).toEqual(['META', 'NVDA', 'PLTR', 'SOFI']);
    });

    it('deduplicates symbols present in multiple watchlists', () => {
      // Add NVDA to Value Plays as well
      const now = new Date().toISOString();
      db.exec(`
        INSERT INTO watchlist_items (id, watchlist_id, symbol, created_at, updated_at)
        VALUES ('wli-dup', 'wl-value', 'NVDA', '${now}', '${now}')
      `);

      const symbols = repo.getAllSymbols();

      // Should still have 4 unique symbols
      expect(symbols).toHaveLength(4);
      expect(symbols).toEqual(['META', 'NVDA', 'PLTR', 'SOFI']);
    });

    it('returns empty array when no watchlist items exist', () => {
      db.exec('DELETE FROM watchlist_items');
      const symbols = repo.getAllSymbols();

      expect(symbols).toHaveLength(0);
    });

    it('sorts symbols alphabetically', () => {
      const symbols = repo.getAllSymbols();
      const sorted = [...symbols].sort();

      expect(symbols).toEqual(sorted);
    });
  });

  describe('database constraints', () => {
    it('enforces UNIQUE(watchlist_id, symbol) constraint', () => {
      const now = new Date().toISOString();

      // Try to insert duplicate symbol in same watchlist
      expect(() => {
        db.exec(`
          INSERT INTO watchlist_items (id, watchlist_id, symbol, created_at, updated_at)
          VALUES ('wli-dup', 'wl-growth', 'NVDA', '${now}', '${now}')
        `);
      }).toThrow();
    });

    it('allows same symbol in different watchlists', () => {
      const now = new Date().toISOString();

      // Add NVDA to Value Plays (already in High Growth)
      expect(() => {
        db.exec(`
          INSERT INTO watchlist_items (id, watchlist_id, symbol, created_at, updated_at)
          VALUES ('wli-nvda-value', 'wl-value', 'NVDA', '${now}', '${now}')
        `);
      }).not.toThrow();

      const symbols = repo.getAllSymbols();
      expect(symbols.filter(s => s === 'NVDA')).toHaveLength(1); // deduplicated
    });

    it('CASCADE deletes items when watchlist is deleted', () => {
      // Verify items exist
      let watchlist = repo.getByNameWithItems('High Growth');
      expect(watchlist!.items).toHaveLength(2);

      // Delete watchlist
      db.exec("DELETE FROM watchlists WHERE name = 'High Growth'");

      // Items should be gone
      const remainingSymbols = repo.getAllSymbols();
      expect(remainingSymbols).not.toContain('META'); // META only in High Growth
      expect(remainingSymbols).toContain('SOFI'); // SOFI in Value Plays
    });

    it('SET NULL on security_id when security is deleted', () => {
      // Must delete dependencies first due to other FK constraints
      // Order: position_intents → positions → price_history → securities
      db.exec("DELETE FROM position_intents WHERE position_id = 'pos-nvda'");
      db.exec("DELETE FROM positions WHERE security_id = 'sec-nvda'");
      db.exec("DELETE FROM price_history WHERE security_id = 'sec-nvda'");

      // Now delete NVDA security
      db.exec("DELETE FROM securities WHERE symbol = 'NVDA'");

      const watchlist = repo.getByNameWithItems('High Growth');
      const nvda = watchlist!.items.find(i => i.symbol === 'NVDA');

      // Item should still exist with symbol, but security_id is NULL
      expect(nvda).toBeDefined();
      expect(nvda!.symbol).toBe('NVDA');
      expect(nvda!.price).toBeUndefined(); // price join fails without security
    });
  });

  describe('edge cases', () => {
    it('handles watchlist with NULL description', () => {
      const now = new Date().toISOString();
      db.exec(`
        INSERT INTO watchlists (id, name, description, created_at, updated_at)
        VALUES ('wl-no-desc', 'No Description', NULL, '${now}', '${now}')
      `);

      const summaries = repo.getAllWithItemCounts();
      const noDesc = summaries.find(s => s.name === 'No Description');

      expect(noDesc!.description).toBeUndefined();
    });

    it('handles items with all optional fields as NULL', () => {
      const now = new Date().toISOString();
      db.exec(`
        INSERT INTO watchlist_items (id, watchlist_id, symbol, security_id, notes, target_entry_price, target_exit_price, thesis_snippet, created_at, updated_at)
        VALUES ('wli-minimal', 'wl-growth', 'AAPL', NULL, NULL, NULL, NULL, NULL, '${now}', '${now}')
      `);

      const watchlist = repo.getByNameWithItems('High Growth');
      const aapl = watchlist!.items.find(i => i.symbol === 'AAPL');

      expect(aapl).toBeDefined();
      expect(aapl!.symbol).toBe('AAPL');
      expect(aapl!.price).toBeUndefined();
      expect(aapl!.targetEntryPrice).toBeUndefined();
      expect(aapl!.targetExitPrice).toBeUndefined();
      expect(aapl!.thesisSnippet).toBeUndefined();
      expect(aapl!.notes).toBeUndefined();
      expect(aapl!.vsTargetPct).toBeUndefined();
    });

    it('handles empty price_history table', () => {
      db.exec('DELETE FROM price_history');

      const watchlist = repo.getByNameWithItems('High Growth');
      const nvda = watchlist!.items.find(i => i.symbol === 'NVDA');

      // Item exists but no price
      expect(nvda).toBeDefined();
      expect(nvda!.price).toBeUndefined();
      expect(nvda!.vsTargetPct).toBeUndefined();
    });

    it('uses latest price from price_history', () => {
      const now = new Date().toISOString();

      // Add older price
      db.exec(`
        INSERT INTO price_history (id, security_id, date, close_price, fetched_at)
        VALUES ('ph-nvda-old', 'sec-nvda', '2026-03-26', 145.00, '${now}')
      `);

      const watchlist = repo.getByNameWithItems('High Growth');
      const nvda = watchlist!.items.find(i => i.symbol === 'NVDA');

      // Should use 2026-03-27 price (150), not 2026-03-26 (145)
      expect(nvda!.price).toBe(150);
    });
  });
});
