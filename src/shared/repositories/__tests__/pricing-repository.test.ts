import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedPortfolio } from './fixture';
import { PricingRepository } from '../pricing-repository';

let db: Database.Database;
let repo: PricingRepository;

beforeEach(() => {
  db = createTestDb();
  seedPortfolio(db);
  repo = new PricingRepository(db);

  // Add 14 days of OHLCV for NVDA to compute ATR
  const now = '2026-03-27T00:00:00Z';
  for (let i = 0; i < 14; i++) {
    const date = `2026-03-${String(13 + i).padStart(2, '0')}`;
    const high = 155 + Math.sin(i) * 5;
    const low = 145 + Math.sin(i) * 5;
    db.exec(`INSERT OR REPLACE INTO price_history (id, security_id, date, open_price, high_price, low_price, close_price, volume, fetched_at)
      VALUES ('ph-nvda-${i}', 'sec-nvda', '${date}', ${(high + low) / 2}, ${high}, ${low}, ${(high + low) / 2}, 1000000, '${now}')`);
  }

  // Add S/R levels for NVDA
  db.exec(`
    INSERT INTO price_levels (id, symbol, level_type, price, strength, source, created_at, updated_at) VALUES
    ('pl-1', 'NVDA', 'support', 140.00, 7, 'swing', '${now}', '${now}'),
    ('pl-2', 'NVDA', 'support', 130.00, 5, 'swing', '${now}', '${now}'),
    ('pl-3', 'NVDA', 'resistance', 165.00, 6, 'swing', '${now}', '${now}');
  `);
});

describe('PricingRepository', () => {
  describe('getLatestPrice', () => {
    it('returns the latest close price for a symbol', () => {
      const price = repo.getLatestPrice('GOOG');
      expect(price).toBe(280);
    });

    it('returns null for unknown symbol', () => {
      expect(repo.getLatestPrice('UNKNOWN')).toBeNull();
    });
  });

  describe('getATRPercent', () => {
    it('computes ATR as avg(high-low)/price × 100 over last 14 bars', () => {
      const atrPct = repo.getATRPercent('NVDA', 14);

      expect(atrPct).not.toBeNull();
      expect(atrPct!).toBeGreaterThan(0);
      expect(atrPct!).toBeLessThan(20); // sanity check
    });

    it('returns null for symbol with insufficient price history', () => {
      expect(repo.getATRPercent('SOFI', 14)).toBeNull();
    });
  });

  describe('getSupportLevels', () => {
    it('returns support levels below current price sorted descending', () => {
      const levels = repo.getSupportLevels('NVDA');

      expect(levels).toHaveLength(2);
      expect(levels[0]).toBe(140); // nearest first
      expect(levels[1]).toBe(130);
    });

    it('returns empty for symbol with no levels', () => {
      expect(repo.getSupportLevels('GOOG')).toHaveLength(0);
    });
  });

  describe('getResistanceLevels', () => {
    it('returns resistance levels above current price sorted ascending', () => {
      const levels = repo.getResistanceLevels('NVDA');

      expect(levels).toHaveLength(1);
      expect(levels[0]).toBe(165);
    });
  });
});
