import { describe, it, expect } from 'vitest';
import {
  calculatePositionSize,
  calculateTranches,
  getTierLimit,
  type SizingInput,
  type SizingResult,
  type TrancheInput,
  type Tranche,
} from './sizing';

describe('getTierLimit', () => {
  it('returns 25 for Core', () => {
    expect(getTierLimit('Core')).toBe(25);
  });

  it('returns 10 for Growth', () => {
    expect(getTierLimit('Growth')).toBe(10);
  });

  it('returns 5 for Starter', () => {
    expect(getTierLimit('Starter')).toBe(5);
  });

  it('returns 5 for unknown tier', () => {
    expect(getTierLimit('Watchlist')).toBe(5);
    expect(getTierLimit('')).toBe(5);
  });
});

describe('calculatePositionSize', () => {
  const base: SizingInput = {
    currentPrice: 100,
    currentShares: 0,
    portfolioTotal: 100000,
    tier: 'Growth',
    targetPctOverride: null,
  };

  describe('room calculation', () => {
    it('calculates full room for a new position', () => {
      const result = calculatePositionSize(base);

      // Growth = 10%, portfolio = $100k → target = $10,000 = 100 shares
      expect(result.tierLimitPct).toBe(10);
      expect(result.targetMarketValue).toBe(10000);
      expect(result.targetShares).toBe(100);
      expect(result.roomMarketValue).toBe(10000);
      expect(result.roomShares).toBe(100);
    });

    it('calculates remaining room for an existing position', () => {
      const result = calculatePositionSize({
        ...base,
        currentShares: 60, // $6,000 = 6% of $100k
      });

      // Room = $10,000 - $6,000 = $4,000 = 40 shares
      expect(result.currentMarketValue).toBe(6000);
      expect(result.currentPct).toBeCloseTo(6, 1);
      expect(result.roomMarketValue).toBe(4000);
      expect(result.roomShares).toBe(40);
    });

    it('clamps room to zero when over-allocated', () => {
      const result = calculatePositionSize({
        ...base,
        currentShares: 150, // $15,000 = 15%, over Growth 10%
      });

      expect(result.roomMarketValue).toBe(0);
      expect(result.roomShares).toBe(0);
    });

    it('uses targetPctOverride when provided', () => {
      const result = calculatePositionSize({
        ...base,
        tier: 'Starter', // normally 5%
        targetPctOverride: 8,
      });

      // Override to 8% → $8,000 target
      expect(result.targetMarketValue).toBe(8000);
      expect(result.targetShares).toBe(80);
    });
  });

  describe('tier-specific limits', () => {
    it('Core position gets 25% limit', () => {
      const result = calculatePositionSize({ ...base, tier: 'Core' });
      expect(result.tierLimitPct).toBe(25);
      expect(result.targetMarketValue).toBe(25000);
    });

    it('Starter position gets 5% limit', () => {
      const result = calculatePositionSize({ ...base, tier: 'Starter' });
      expect(result.tierLimitPct).toBe(5);
      expect(result.targetMarketValue).toBe(5000);
    });
  });

  describe('edge cases', () => {
    it('handles zero portfolio total', () => {
      const result = calculatePositionSize({ ...base, portfolioTotal: 0 });
      expect(result.targetMarketValue).toBe(0);
      expect(result.roomShares).toBe(0);
    });

    it('handles zero price', () => {
      const result = calculatePositionSize({ ...base, currentPrice: 0 });
      expect(result.targetShares).toBe(0);
      expect(result.roomShares).toBe(0);
    });
  });
});

describe('calculateTranches', () => {
  describe('ATR-adjusted weights', () => {
    const baseInput: TrancheInput = {
      addShares: 100,
      currentPrice: 100,
      atrPct: 3.0, // medium volatility
      supportLevels: [95, 90], // S1 at $95, S2 at $90
    };

    it('uses 20/30/50 split for medium volatility (2-4% ATR)', () => {
      const tranches = calculateTranches(baseInput);

      expect(tranches).toHaveLength(3);
      expect(tranches[0].shares).toBe(20);  // 20% at S1
      expect(tranches[1].shares).toBe(30);  // 30% at S2
      expect(tranches[2].shares).toBe(50);  // 50% thesis confirm
    });

    it('uses 15/35/50 split for high volatility (>4% ATR)', () => {
      const tranches = calculateTranches({ ...baseInput, atrPct: 5.0 });

      expect(tranches[0].shares).toBe(15);
      expect(tranches[1].shares).toBe(35);
      expect(tranches[2].shares).toBe(50);
    });

    it('uses 25/25/50 split for low volatility (<2% ATR)', () => {
      const tranches = calculateTranches({ ...baseInput, atrPct: 1.5 });

      expect(tranches[0].shares).toBe(25);
      expect(tranches[1].shares).toBe(25);
      expect(tranches[2].shares).toBe(50);
    });
  });

  describe('S/R-based entry prices', () => {
    it('places T1 at nearest support and T2 at second support', () => {
      const tranches = calculateTranches({
        addShares: 100,
        currentPrice: 100,
        atrPct: 3.0,
        supportLevels: [95, 88],
      });

      expect(tranches[0].entryPrice).toBe(95);
      expect(tranches[0].dipPct).toBeCloseTo(5.0, 1);
      expect(tranches[1].entryPrice).toBe(88);
      expect(tranches[1].dipPct).toBeCloseTo(12.0, 1);
      expect(tranches[2].entryPrice).toBe(100); // at market
      expect(tranches[2].dipPct).toBe(0);
    });
  });

  describe('ATR-dip fallback (no support levels)', () => {
    it('uses ATR-based dips when no support levels', () => {
      const tranches = calculateTranches({
        addShares: 90,
        currentPrice: 100,
        atrPct: 3.0,
        supportLevels: [],
      });

      // Fallback: T1 at market, T2 at -atrPct, T3 at -2*atrPct
      expect(tranches[0].entryPrice).toBe(100);      // now
      expect(tranches[1].entryPrice).toBeCloseTo(97, 0);  // -3%
      expect(tranches[2].entryPrice).toBeCloseTo(94, 0);  // -6%
    });

    it('uses 3%/6% default when no ATR and no support', () => {
      const tranches = calculateTranches({
        addShares: 90,
        currentPrice: 100,
        atrPct: 0,
        supportLevels: [],
      });

      expect(tranches[0].entryPrice).toBe(100);
      expect(tranches[1].entryPrice).toBeCloseTo(97, 0);
      expect(tranches[2].entryPrice).toBeCloseTo(94, 0);
    });

    it('uses ATR dip for T2 when only one support level', () => {
      const tranches = calculateTranches({
        addShares: 100,
        currentPrice: 100,
        atrPct: 3.0,
        supportLevels: [95], // only S1
      });

      expect(tranches[0].entryPrice).toBe(95);         // S1
      expect(tranches[1].entryPrice).toBeCloseTo(94, 0); // fallback -6%
      expect(tranches[2].entryPrice).toBe(100);           // at market
    });
  });

  describe('share minimums and remainder', () => {
    it('enforces minimum 1 share per tranche', () => {
      const tranches = calculateTranches({
        addShares: 3,
        currentPrice: 100,
        atrPct: 5.0, // high vol: 15/35/50 → 0.45/1.05/1.5
        supportLevels: [95, 90],
      });

      // Each tranche must have at least 1 share
      for (const t of tranches) {
        expect(t.shares).toBeGreaterThanOrEqual(1);
      }
      expect(tranches.reduce((s, t) => s + t.shares, 0)).toBe(3);
    });

    it('allocates remainder to last tranche', () => {
      const tranches = calculateTranches({
        addShares: 10,
        currentPrice: 100,
        atrPct: 3.0, // medium: 20/30/50 → 2/3/5
        supportLevels: [95, 90],
      });

      // 20% of 10 = 2, 30% of 10 = 3, remainder = 5
      expect(tranches[0].shares).toBe(2);
      expect(tranches[1].shares).toBe(3);
      expect(tranches[2].shares).toBe(5);
      expect(tranches.reduce((s, t) => s + t.shares, 0)).toBe(10);
    });
  });

  describe('tranche labels', () => {
    it('labels tranches with S/R levels', () => {
      const tranches = calculateTranches({
        addShares: 100,
        currentPrice: 100,
        atrPct: 3.0,
        supportLevels: [95, 90],
      });

      expect(tranches[0].label).toContain('S1');
      expect(tranches[1].label).toContain('S2');
      expect(tranches[2].label).toContain('thesis');
    });

    it('labels fallback tranches appropriately', () => {
      const tranches = calculateTranches({
        addShares: 100,
        currentPrice: 100,
        atrPct: 3.0,
        supportLevels: [],
      });

      expect(tranches[0].label).toContain('now');
      expect(tranches[1].label).toContain('dip');
      expect(tranches[2].label).toContain('dip');
    });
  });

  describe('edge cases', () => {
    it('handles zero addShares', () => {
      const tranches = calculateTranches({
        addShares: 0,
        currentPrice: 100,
        atrPct: 3.0,
        supportLevels: [95, 90],
      });

      expect(tranches).toHaveLength(0);
    });

    it('handles 1 share total', () => {
      const tranches = calculateTranches({
        addShares: 1,
        currentPrice: 100,
        atrPct: 3.0,
        supportLevels: [95, 90],
      });

      // Only 1 share — single tranche
      expect(tranches).toHaveLength(1);
      expect(tranches[0].shares).toBe(1);
    });

    it('handles 2 shares total', () => {
      const tranches = calculateTranches({
        addShares: 2,
        currentPrice: 100,
        atrPct: 3.0,
        supportLevels: [95, 90],
      });

      // 2 shares — two tranches at most
      expect(tranches.length).toBeLessThanOrEqual(2);
      expect(tranches.reduce((s, t) => s + t.shares, 0)).toBe(2);
    });
  });
});
