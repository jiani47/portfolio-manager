import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedPortfolio } from './fixture';
import { PositionRepository } from '../position-repository';

let db: Database.Database;
let repo: PositionRepository;

beforeEach(() => {
  db = createTestDb();
  seedPortfolio(db);
  repo = new PositionRepository(db);
});

describe('PositionRepository', () => {
  describe('getAllForAllocation', () => {
    it('returns all non-zero positions with latest price and intent', () => {
      const rows = repo.getAllForAllocation();

      // 4 equity/cash positions (GOOG×2 accounts, NVDA, SOFI) + 2 cash
      expect(rows.length).toBe(6);
    });

    it('includes correct price from price_history', () => {
      const rows = repo.getAllForAllocation();
      const goog = rows.find(r => r.symbol === 'GOOG' && r.accountId === 'acct-1');

      expect(goog).toBeDefined();
      expect(goog!.price).toBe(280);
    });

    it('includes intent fields when present', () => {
      const rows = repo.getAllForAllocation();
      const goog = rows.find(r => r.symbol === 'GOOG' && r.accountId === 'acct-1');

      expect(goog!.tier).toBe('Core');
      expect(goog!.targetAllocationPct).toBe(15.0);
    });

    it('returns null target and Untagged tier when no intent', () => {
      const rows = repo.getAllForAllocation();
      // pos-goog-2 has no intent
      const goog2 = rows.find(r => r.symbol === 'GOOG' && r.accountId === 'acct-2');

      expect(goog2!.targetAllocationPct).toBeNull();
      expect(goog2!.tier).toBe('Untagged');
    });

    it('returns cash positions with securityType=cash and price=1', () => {
      const rows = repo.getAllForAllocation();
      const cash = rows.filter(r => r.securityType === 'cash');

      expect(cash).toHaveLength(2);
      // Cash quantity IS the dollar amount — price should be 1 (or quantity itself)
      expect(cash[0].quantity).toBe(10000);
    });

    it('returns correct securityType for each position', () => {
      const rows = repo.getAllForAllocation();
      const nvda = rows.find(r => r.symbol === 'NVDA');
      const cash = rows.find(r => r.symbol === 'USD');

      expect(nvda!.securityType).toBe('stock');
      expect(cash!.securityType).toBe('cash');
    });

    it('excludes positions with zero quantity', () => {
      db.exec("UPDATE positions SET quantity = 0 WHERE id = 'pos-sofi'");
      const rows = repo.getAllForAllocation();

      expect(rows.find(r => r.symbol === 'SOFI')).toBeUndefined();
    });
  });
});
