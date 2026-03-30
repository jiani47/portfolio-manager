import { describe, it, expect } from 'vitest';
import {
  getPegRating,
  calculateFairPriceRange,
  calculateEpsGrowth,
  calculateForwardPe,
  calculateTrailingEps,
  type FairPriceRange,
} from './valuation';

describe('getPegRating', () => {
  it('returns CHEAP for forward PEG < 0.8', () => {
    expect(getPegRating(0.5)).toBe('CHEAP');
    expect(getPegRating(0.79)).toBe('CHEAP');
  });

  it('returns FAIR for forward PEG 0.8 to 1.2', () => {
    expect(getPegRating(0.8)).toBe('FAIR');
    expect(getPegRating(1.0)).toBe('FAIR');
    expect(getPegRating(1.19)).toBe('FAIR');
  });

  it('returns RICH for forward PEG 1.2 to 2.0', () => {
    expect(getPegRating(1.2)).toBe('RICH');
    expect(getPegRating(1.5)).toBe('RICH');
    expect(getPegRating(1.99)).toBe('RICH');
  });

  it('returns PRICEY for forward PEG >= 2.0', () => {
    expect(getPegRating(2.0)).toBe('PRICEY');
    expect(getPegRating(5.0)).toBe('PRICEY');
  });

  it('returns null for zero or negative PEG', () => {
    expect(getPegRating(0)).toBeNull();
    expect(getPegRating(-1.5)).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(getPegRating(null)).toBeNull();
    expect(getPegRating(undefined)).toBeNull();
  });
});

describe('calculateFairPriceRange', () => {
  describe('domestic growth stock (PE > 30)', () => {
    it('uses 75/90/110 multipliers', () => {
      // fwd_eps=5, fwd_pe=40 → base=200
      const result = calculateFairPriceRange({
        eps: 5,
        pe: 40,
        epsGrowthPct: null,
        isAdr: false,
      });

      expect(result!.fairLow).toBeCloseTo(150, 0);   // 200 * 0.75
      expect(result!.fairMid).toBeCloseTo(180, 0);    // 200 * 0.90
      expect(result!.fairHigh).toBeCloseTo(220, 0);   // 200 * 1.10
    });
  });

  describe('domestic value stock (PE <= 30)', () => {
    it('uses 85/100/115 multipliers', () => {
      // fwd_eps=10, fwd_pe=20 → base=200
      const result = calculateFairPriceRange({
        eps: 10,
        pe: 20,
        epsGrowthPct: null,
        isAdr: false,
      });

      expect(result!.fairLow).toBeCloseTo(170, 0);   // 200 * 0.85
      expect(result!.fairMid).toBeCloseTo(200, 0);    // 200 * 1.0
      expect(result!.fairHigh).toBeCloseTo(230, 0);   // 200 * 1.15
    });
  });

  describe('PEG=1 ceiling adjustment', () => {
    it('raises fairHigh when PEG=1 price exceeds it', () => {
      // fwd_eps=5, fwd_pe=25 (value), eps_growth=50%
      // base = 125. Value: low=106.25, mid=125, high=143.75
      // PEG=1 price = 5 * 50 = 250 > 143.75 → high = 250
      const result = calculateFairPriceRange({
        eps: 5,
        pe: 25,
        epsGrowthPct: 50,
        isAdr: false,
      });

      expect(result!.fairHigh).toBeCloseTo(250, 0);
    });

    it('does not lower fairHigh when PEG=1 price is below it', () => {
      // fwd_eps=5, fwd_pe=40 (growth), eps_growth=10%
      // base = 200. Growth: low=150, mid=180, high=220
      // PEG=1 price = 5 * 10 = 50 < 220 → high stays 220
      const result = calculateFairPriceRange({
        eps: 5,
        pe: 40,
        epsGrowthPct: 10,
        isAdr: false,
      });

      expect(result!.fairHigh).toBeCloseTo(220, 0);
    });

    it('skips PEG=1 adjustment when growth is negative', () => {
      const result = calculateFairPriceRange({
        eps: 10,
        pe: 20,
        epsGrowthPct: -5,
        isAdr: false,
      });

      // Value: base=200, high=230. Negative growth → no PEG=1 adjust
      expect(result!.fairHigh).toBeCloseTo(230, 0);
    });
  });

  describe('ADR handling', () => {
    it('uses same multiplier logic for ADRs', () => {
      // ADR with trailing PE=15 (value), trailing_eps=8
      // base = 120. Value: 102/120/138
      const result = calculateFairPriceRange({
        eps: 8,
        pe: 15,
        epsGrowthPct: null,
        isAdr: true,
      });

      expect(result!.fairLow).toBeCloseTo(102, 0);
      expect(result!.fairMid).toBeCloseTo(120, 0);
      expect(result!.fairHigh).toBeCloseTo(138, 0);
    });

    it('does NOT apply PEG=1 ceiling for ADRs', () => {
      // ADR: PEG=1 adjustment skipped because forward EPS in local currency
      const result = calculateFairPriceRange({
        eps: 8,
        pe: 15,
        epsGrowthPct: 100, // would produce huge PEG=1 price
        isAdr: true,
      });

      // Value: base=120, high=138. Should NOT be raised to 8*100=800
      expect(result!.fairHigh).toBeCloseTo(138, 0);
    });
  });

  describe('edge cases', () => {
    it('returns null range when EPS is null', () => {
      const result = calculateFairPriceRange({
        eps: null,
        pe: 20,
        epsGrowthPct: null,
        isAdr: false,
      });

      expect(result).toBeNull();
    });

    it('returns null range when PE is null', () => {
      const result = calculateFairPriceRange({
        eps: 10,
        pe: null,
        epsGrowthPct: null,
        isAdr: false,
      });

      expect(result).toBeNull();
    });

    it('returns null range when PE is zero', () => {
      const result = calculateFairPriceRange({
        eps: 10,
        pe: 0,
        epsGrowthPct: null,
        isAdr: false,
      });

      expect(result).toBeNull();
    });

    it('returns null range when EPS is negative', () => {
      const result = calculateFairPriceRange({
        eps: -5,
        pe: 20,
        epsGrowthPct: null,
        isAdr: false,
      });

      expect(result).toBeNull();
    });
  });
});

describe('calculateEpsGrowth', () => {
  it('calculates YoY growth between two EPS values', () => {
    expect(calculateEpsGrowth(4.0, 5.0)).toBeCloseTo(25, 1);
  });

  it('handles negative growth', () => {
    expect(calculateEpsGrowth(5.0, 4.0)).toBeCloseTo(-20, 1);
  });

  it('returns null when current EPS is zero', () => {
    expect(calculateEpsGrowth(0, 5.0)).toBeNull();
  });

  it('returns null when either is null', () => {
    expect(calculateEpsGrowth(null, 5.0)).toBeNull();
    expect(calculateEpsGrowth(4.0, null)).toBeNull();
  });
});

describe('calculateForwardPe', () => {
  it('divides price by forward EPS', () => {
    expect(calculateForwardPe(200, 10)).toBeCloseTo(20, 1);
  });

  it('returns null when forward EPS is zero', () => {
    expect(calculateForwardPe(200, 0)).toBeNull();
  });

  it('returns null when forward EPS is null', () => {
    expect(calculateForwardPe(200, null)).toBeNull();
  });
});

describe('calculateTrailingEps', () => {
  it('derives EPS from price and trailing PE', () => {
    // price=200, pe=20 → eps=10
    expect(calculateTrailingEps(200, 20)).toBeCloseTo(10, 2);
  });

  it('returns null when PE is zero', () => {
    expect(calculateTrailingEps(200, 0)).toBeNull();
  });

  it('returns null when PE is null', () => {
    expect(calculateTrailingEps(200, null)).toBeNull();
  });
});
