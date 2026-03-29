import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedPortfolio } from './fixture';
import { ValuationRepository } from '../valuation-repository';

let db: Database.Database;
let repo: ValuationRepository;

beforeEach(() => {
  db = createTestDb();
  seedPortfolio(db);
  repo = new ValuationRepository(db);

  const now = '2026-03-27T00:00:00Z';
  db.exec(`
    INSERT INTO valuation_metrics (id, symbol, date, trailing_pe, forward_pe, peg, forward_peg, ps_ratio,
      trailing_eps, forward_eps, eps_growth_pct, fair_low, fair_mid, fair_high, peg_rating, fetched_at) VALUES
    ('vm-goog', 'GOOG', '2026-03-27', 22.0, 20.0, 1.1, 0.9, 6.5,
      12.73, 14.0, 25.0, 240.0, 280.0, 320.0, 'FAIR', '${now}'),
    ('vm-nvda', 'NVDA', '2026-03-27', 50.0, 35.0, 2.5, 1.8, 30.0,
      3.0, 4.29, 40.0, 112.0, 135.0, 165.0, 'RICH', '${now}'),
    ('vm-goog-old', 'GOOG', '2026-03-20', 23.0, 21.0, 1.2, 1.0, 6.8,
      12.0, 13.5, 20.0, 230.0, 270.0, 310.0, 'FAIR', '${now}');
  `);
});

describe('ValuationRepository', () => {
  describe('getLatest', () => {
    it('returns the most recent valuation for a symbol', () => {
      const v = repo.getLatest('GOOG');

      expect(v).not.toBeNull();
      expect(v!.date).toBe('2026-03-27');
      expect(v!.trailingPe).toBe(22.0);
      expect(v!.forwardPe).toBe(20.0);
      expect(v!.forwardPeg).toBe(0.9);
      expect(v!.pegRating).toBe('FAIR');
      expect(v!.fairLow).toBe(240);
      expect(v!.fairMid).toBe(280);
      expect(v!.fairHigh).toBe(320);
    });

    it('returns null for unknown symbol', () => {
      expect(repo.getLatest('UNKNOWN')).toBeNull();
    });
  });

  describe('getAll', () => {
    it('returns latest valuation for each symbol', () => {
      const all = repo.getAll();

      expect(all).toHaveLength(2); // GOOG + NVDA (GOOG deduped to latest)
      const goog = all.find(v => v.symbol === 'GOOG');
      expect(goog!.date).toBe('2026-03-27'); // latest, not old
    });
  });
});
