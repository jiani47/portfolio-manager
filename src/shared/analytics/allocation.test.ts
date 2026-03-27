import { describe, it, expect } from 'vitest';
import {
  calculateAllocationDrift,
  type AllocationInput,
  type AllocationRow,
} from './allocation';

// Helper to build position inputs concisely
function pos(
  symbol: string,
  quantity: number,
  price: number,
  opts: { type?: string; targetPct?: number; tier?: string; accountId?: string } = {},
): AllocationInput['positions'][0] {
  return {
    symbol,
    quantity,
    price,
    securityType: (opts.type as AllocationInput['positions'][0]['securityType']) || 'stock',
    targetAllocationPct: opts.targetPct ?? null,
    tier: opts.tier || 'Untagged',
    accountId: opts.accountId || 'acct-1',
  };
}

function findRow(rows: AllocationRow[], symbol: string): AllocationRow {
  const row = rows.find((r) => r.symbol === symbol);
  if (!row) throw new Error(`No row for ${symbol}`);
  return row;
}

describe('calculateAllocationDrift', () => {
  describe('basic allocation percentages', () => {
    it('calculates current % for a single position', () => {
      const result = calculateAllocationDrift({
        positions: [pos('AAPL', 100, 200, { targetPct: 50 })],
      });

      const aapl = findRow(result, 'AAPL');
      expect(aapl.currentPct).toBeCloseTo(100 * 200 / (100 * 200) * 100, 1);
      // Sole equity position = 100% of equity, but cash row exists
      // totalPortfolioValue includes cash (0 here), so AAPL is 100% of total
      expect(aapl.marketValue).toBe(20000);
    });

    it('calculates current % for multiple positions', () => {
      const result = calculateAllocationDrift({
        positions: [
          pos('AAPL', 100, 100, { targetPct: 50 }), // $10,000
          pos('GOOG', 50, 200, { targetPct: 50 }),   // $10,000
        ],
      });

      expect(findRow(result, 'AAPL').currentPct).toBeCloseTo(50, 1);
      expect(findRow(result, 'GOOG').currentPct).toBeCloseTo(50, 1);
    });

    it('handles unequal position sizes', () => {
      const result = calculateAllocationDrift({
        positions: [
          pos('AAPL', 100, 100, { targetPct: 25 }),  // $10,000
          pos('GOOG', 150, 200, { targetPct: 75 }),   // $30,000
        ],
      });

      expect(findRow(result, 'AAPL').currentPct).toBeCloseTo(25, 1);
      expect(findRow(result, 'GOOG').currentPct).toBeCloseTo(75, 1);
    });
  });

  describe('drift calculation', () => {
    it('computes drift as currentPct minus targetPct', () => {
      const result = calculateAllocationDrift({
        positions: [
          pos('AAPL', 100, 100, { targetPct: 30 }),  // $10k = 25% → drift -5
          pos('GOOG', 150, 200, { targetPct: 70 }),   // $30k = 75% → drift +5
        ],
      });

      expect(findRow(result, 'AAPL').driftPct).toBeCloseTo(-5, 1);
      expect(findRow(result, 'GOOG').driftPct).toBeCloseTo(5, 1);
    });

    it('returns null drift when no target set', () => {
      const result = calculateAllocationDrift({
        positions: [
          pos('AAPL', 100, 100),  // no target
          pos('GOOG', 100, 100, { targetPct: 50 }),
        ],
      });

      expect(findRow(result, 'AAPL').driftPct).toBeNull();
      expect(findRow(result, 'GOOG').driftPct).not.toBeNull();
    });

    it('returns zero drift when perfectly allocated', () => {
      const result = calculateAllocationDrift({
        positions: [
          pos('AAPL', 100, 100, { targetPct: 50 }),
          pos('GOOG', 100, 100, { targetPct: 50 }),
        ],
      });

      expect(findRow(result, 'AAPL').driftPct).toBeCloseTo(0, 1);
      expect(findRow(result, 'GOOG').driftPct).toBeCloseTo(0, 1);
    });
  });

  describe('multi-account aggregation', () => {
    it('aggregates positions with same symbol across accounts', () => {
      const result = calculateAllocationDrift({
        positions: [
          pos('AAPL', 50, 100, { targetPct: 50, accountId: 'acct-1' }),
          pos('AAPL', 50, 100, { targetPct: 50, accountId: 'acct-2' }),
          pos('GOOG', 100, 100, { targetPct: 50, accountId: 'acct-1' }),
        ],
      });

      // AAPL: 50*100 + 50*100 = $10,000
      // GOOG: 100*100 = $10,000
      // Total = $20,000
      const aapl = findRow(result, 'AAPL');
      expect(aapl.marketValue).toBe(10000);
      expect(aapl.currentPct).toBeCloseTo(50, 1);

      // Only one AAPL row, not two
      expect(result.filter((r) => r.symbol === 'AAPL')).toHaveLength(1);
    });

    it('uses targetPct from whichever position has it set', () => {
      const result = calculateAllocationDrift({
        positions: [
          pos('AAPL', 50, 100, { accountId: 'acct-1' }),                      // no target
          pos('AAPL', 50, 100, { targetPct: 40, accountId: 'acct-2' }),        // has target
          pos('GOOG', 100, 100, { targetPct: 60, accountId: 'acct-1' }),
        ],
      });

      expect(findRow(result, 'AAPL').targetPct).toBe(40);
    });

    it('uses tier from whichever position has it set', () => {
      const result = calculateAllocationDrift({
        positions: [
          pos('AAPL', 50, 100, { tier: 'Untagged', accountId: 'acct-1' }),
          pos('AAPL', 50, 100, { tier: 'Core', accountId: 'acct-2' }),
          pos('GOOG', 100, 100, { tier: 'Growth', accountId: 'acct-1' }),
        ],
      });

      expect(findRow(result, 'AAPL').tier).toBe('Core');
    });
  });

  describe('cash handling', () => {
    it('includes cash as a separate row', () => {
      const result = calculateAllocationDrift({
        positions: [
          pos('AAPL', 100, 100, { targetPct: 80 }),   // $10,000
          pos('USD', 5000, 1, { type: 'cash' }),        // $5,000
        ],
      });

      const cash = findRow(result, 'Cash');
      expect(cash.marketValue).toBe(5000);
      expect(cash.tier).toBe('Cash');
    });

    it('includes cash in total portfolio value for percentages', () => {
      const result = calculateAllocationDrift({
        positions: [
          pos('AAPL', 100, 100, { targetPct: 80 }),  // $10,000
          pos('USD', 5000, 1, { type: 'cash' }),       // $5,000
        ],
      });

      // Total = $15,000. AAPL = 10000/15000 = 66.7%
      expect(findRow(result, 'AAPL').currentPct).toBeCloseTo(66.7, 1);
      expect(findRow(result, 'Cash').currentPct).toBeCloseTo(33.3, 1);
    });

    it('computes implied cash target as 100 minus sum of equity targets', () => {
      const result = calculateAllocationDrift({
        positions: [
          pos('AAPL', 100, 100, { targetPct: 40 }),
          pos('GOOG', 100, 100, { targetPct: 30 }),
          pos('USD', 5000, 1, { type: 'cash' }),
        ],
      });

      // Assigned targets: 40 + 30 = 70%. Cash target = 30%
      expect(findRow(result, 'Cash').targetPct).toBeCloseTo(30, 1);
    });

    it('clamps cash target to zero when equity targets exceed 100%', () => {
      const result = calculateAllocationDrift({
        positions: [
          pos('AAPL', 100, 100, { targetPct: 60 }),
          pos('GOOG', 100, 100, { targetPct: 50 }),
          pos('USD', 1000, 1, { type: 'cash' }),
        ],
      });

      expect(findRow(result, 'Cash').targetPct).toBe(0);
    });

    it('aggregates cash across multiple accounts', () => {
      const result = calculateAllocationDrift({
        positions: [
          pos('AAPL', 100, 100, { targetPct: 80 }),
          pos('USD', 3000, 1, { type: 'cash', accountId: 'acct-1' }),
          pos('USD', 2000, 1, { type: 'cash', accountId: 'acct-2' }),
        ],
      });

      expect(findRow(result, 'Cash').marketValue).toBe(5000);
    });

    it('shows cash row even when no cash positions exist', () => {
      const result = calculateAllocationDrift({
        positions: [
          pos('AAPL', 100, 100, { targetPct: 50 }),
          pos('GOOG', 100, 100, { targetPct: 50 }),
        ],
      });

      const cash = findRow(result, 'Cash');
      expect(cash.marketValue).toBe(0);
      expect(cash.currentPct).toBe(0);
      expect(cash.targetPct).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('returns empty cash-only result for empty input', () => {
      const result = calculateAllocationDrift({ positions: [] });
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe('Cash');
    });

    it('excludes option positions from calculations', () => {
      const result = calculateAllocationDrift({
        positions: [
          pos('AAPL', 100, 100, { targetPct: 100 }),
          pos('AAPL 250C', 5, 300, { type: 'option' }),
        ],
      });

      // Options excluded — only AAPL equity + Cash row
      expect(result.filter((r) => r.symbol !== 'Cash')).toHaveLength(1);
      expect(findRow(result, 'AAPL').marketValue).toBe(10000);
    });

    it('handles zero-quantity positions gracefully', () => {
      const result = calculateAllocationDrift({
        positions: [
          pos('AAPL', 0, 100, { targetPct: 50 }),
          pos('GOOG', 100, 100, { targetPct: 50 }),
        ],
      });

      // AAPL with 0 qty should not appear (or appear with 0 MV)
      const aapl = result.find((r) => r.symbol === 'AAPL');
      if (aapl) {
        expect(aapl.marketValue).toBe(0);
      }
      expect(findRow(result, 'GOOG').currentPct).toBeCloseTo(100, 1);
    });

    it('handles zero-price positions gracefully', () => {
      const result = calculateAllocationDrift({
        positions: [
          pos('AAPL', 100, 0, { targetPct: 50 }),
          pos('GOOG', 100, 100, { targetPct: 50 }),
        ],
      });

      expect(findRow(result, 'GOOG').currentPct).toBeCloseTo(100, 1);
    });

    it('target market value is computed from target pct and total value', () => {
      const result = calculateAllocationDrift({
        positions: [
          pos('AAPL', 100, 100, { targetPct: 40 }),  // $10,000
          pos('GOOG', 100, 100, { targetPct: 50 }),   // $10,000
        ],
      });

      // Total = $20,000. AAPL target = 40% of $20k = $8,000
      expect(findRow(result, 'AAPL').targetMarketValue).toBeCloseTo(8000, 0);
      expect(findRow(result, 'GOOG').targetMarketValue).toBeCloseTo(10000, 0);
    });

    it('returns null targetMarketValue when no target set', () => {
      const result = calculateAllocationDrift({
        positions: [pos('AAPL', 100, 100)],
      });

      expect(findRow(result, 'AAPL').targetMarketValue).toBeNull();
    });
  });

  describe('sorting', () => {
    it('sorts by absolute drift descending, Cash always last', () => {
      const result = calculateAllocationDrift({
        positions: [
          pos('AAPL', 100, 100, { targetPct: 10 }),  // $10k=33%, drift +23
          pos('GOOG', 100, 100, { targetPct: 50 }),   // $10k=33%, drift -17
          pos('TSLA', 100, 100, { targetPct: 30 }),   // $10k=33%, drift +3
          pos('USD', 1000, 1, { type: 'cash' }),
        ],
      });

      const symbols = result.map((r) => r.symbol);
      // AAPL has highest abs drift, GOOG second, TSLA third, Cash last
      expect(symbols[symbols.length - 1]).toBe('Cash');
      // First entry should be highest absolute drift
      expect(symbols[0]).toBe('AAPL');
      expect(symbols[1]).toBe('GOOG');
    });
  });
});
