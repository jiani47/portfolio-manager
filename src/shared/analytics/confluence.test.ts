import { describe, it, expect } from 'vitest';
import {
  detectConfluenceSignals,
  calculateScreeningScore,
  type ConfluenceInput,
  type ConfluenceResult,
  type ScreeningInput,
  type ScreeningResult,
} from './confluence';

// --- Confluence Detection ---

function makeInput(overrides: Partial<ConfluenceInput> = {}): ConfluenceInput {
  return {
    symbol: 'AAPL',
    currentPrice: 200,
    forwardPeg: null,
    pegRating: null,
    epsGrowthPct: null,
    nearestSupport: null,
    nearestResistance: null,
    ...overrides,
  };
}

describe('detectConfluenceSignals', () => {
  describe('valuation signal', () => {
    it('fires when PEG rating is CHEAP and forwardPeg < 1.2', () => {
      const result = detectConfluenceSignals(makeInput({
        pegRating: 'CHEAP',
        forwardPeg: 0.5,
      }));

      const val = result.signals.find(s => s.type === 'valuation');
      expect(val).toBeDefined();
      expect(val!.label).toContain('CHEAP');
    });

    it('fires when PEG rating is FAIR and forwardPeg < 1.2', () => {
      const result = detectConfluenceSignals(makeInput({
        pegRating: 'FAIR',
        forwardPeg: 1.0,
      }));

      expect(result.signals.find(s => s.type === 'valuation')).toBeDefined();
    });

    it('does NOT fire when PEG rating is RICH', () => {
      const result = detectConfluenceSignals(makeInput({
        pegRating: 'RICH',
        forwardPeg: 1.5,
      }));

      expect(result.signals.find(s => s.type === 'valuation')).toBeUndefined();
    });

    it('does NOT fire when forwardPeg is null', () => {
      const result = detectConfluenceSignals(makeInput({
        pegRating: 'CHEAP',
        forwardPeg: null,
      }));

      expect(result.signals.find(s => s.type === 'valuation')).toBeUndefined();
    });
  });

  describe('technical signal', () => {
    it('fires when price is within 5% of support', () => {
      const result = detectConfluenceSignals(makeInput({
        currentPrice: 100,
        nearestSupport: 96, // 4% away
      }));

      const tech = result.signals.find(s => s.type === 'technical');
      expect(tech).toBeDefined();
      expect(tech!.label).toContain('96');
    });

    it('does NOT fire when price is more than 5% from support', () => {
      const result = detectConfluenceSignals(makeInput({
        currentPrice: 100,
        nearestSupport: 90, // 10% away
      }));

      expect(result.signals.find(s => s.type === 'technical')).toBeUndefined();
    });

    it('does NOT fire when no support level exists', () => {
      const result = detectConfluenceSignals(makeInput({
        nearestSupport: null,
      }));

      expect(result.signals.find(s => s.type === 'technical')).toBeUndefined();
    });
  });

  describe('growth signal', () => {
    it('fires when EPS growth > 20%', () => {
      const result = detectConfluenceSignals(makeInput({
        epsGrowthPct: 25,
      }));

      const growth = result.signals.find(s => s.type === 'growth');
      expect(growth).toBeDefined();
      expect(growth!.label).toContain('25');
    });

    it('does NOT fire when EPS growth <= 20%', () => {
      const result = detectConfluenceSignals(makeInput({
        epsGrowthPct: 20,
      }));

      expect(result.signals.find(s => s.type === 'growth')).toBeUndefined();
    });

    it('does NOT fire when EPS growth is null', () => {
      const result = detectConfluenceSignals(makeInput({
        epsGrowthPct: null,
      }));

      expect(result.signals.find(s => s.type === 'growth')).toBeUndefined();
    });
  });

  describe('confluence threshold', () => {
    it('hasConfluence is true when 2+ signals align', () => {
      const result = detectConfluenceSignals(makeInput({
        pegRating: 'CHEAP',
        forwardPeg: 0.5,
        epsGrowthPct: 30,
      }));

      expect(result.signals).toHaveLength(2);
      expect(result.hasConfluence).toBe(true);
    });

    it('hasConfluence is false when only 1 signal', () => {
      const result = detectConfluenceSignals(makeInput({
        pegRating: 'CHEAP',
        forwardPeg: 0.5,
      }));

      expect(result.signals).toHaveLength(1);
      expect(result.hasConfluence).toBe(false);
    });

    it('hasConfluence is false when 0 signals', () => {
      const result = detectConfluenceSignals(makeInput());
      expect(result.signals).toHaveLength(0);
      expect(result.hasConfluence).toBe(false);
    });

    it('returns 3 signals when all align', () => {
      const result = detectConfluenceSignals(makeInput({
        pegRating: 'FAIR',
        forwardPeg: 1.0,
        epsGrowthPct: 50,
        currentPrice: 100,
        nearestSupport: 97,
      }));

      expect(result.signals).toHaveLength(3);
      expect(result.hasConfluence).toBe(true);
      expect(result.signalCount).toBe(3);
    });
  });
});

// --- Screening Scores ---

function makeScreenInput(overrides: Partial<ScreeningInput> = {}): ScreeningInput {
  return {
    symbol: 'AAPL',
    currentPrice: 200,
    pegRating: null,
    epsGrowthPct: null,
    nearestSupport: null,
    nearestResistance: null,
    ...overrides,
  };
}

describe('calculateScreeningScore', () => {
  describe('valuation score (0-3)', () => {
    it('gives 3 for CHEAP', () => {
      const result = calculateScreeningScore(makeScreenInput({ pegRating: 'CHEAP' }));
      expect(result.valuationScore).toBe(3);
    });

    it('gives 2 for FAIR', () => {
      const result = calculateScreeningScore(makeScreenInput({ pegRating: 'FAIR' }));
      expect(result.valuationScore).toBe(2);
    });

    it('gives 1 for RICH', () => {
      const result = calculateScreeningScore(makeScreenInput({ pegRating: 'RICH' }));
      expect(result.valuationScore).toBe(1);
    });

    it('gives 0 for PRICEY', () => {
      const result = calculateScreeningScore(makeScreenInput({ pegRating: 'PRICEY' }));
      expect(result.valuationScore).toBe(0);
    });

    it('gives 0 for null rating', () => {
      const result = calculateScreeningScore(makeScreenInput({ pegRating: null }));
      expect(result.valuationScore).toBe(0);
    });
  });

  describe('technical score (-1 to +1)', () => {
    it('gives +1 when near support (within 5%)', () => {
      const result = calculateScreeningScore(makeScreenInput({
        currentPrice: 100,
        nearestSupport: 96,
      }));
      expect(result.technicalScore).toBe(1);
    });

    it('gives -1 when near resistance (within 5%)', () => {
      const result = calculateScreeningScore(makeScreenInput({
        currentPrice: 100,
        nearestResistance: 104,
      }));
      expect(result.technicalScore).toBe(-1);
    });

    it('gives 0 when neither near support nor resistance', () => {
      const result = calculateScreeningScore(makeScreenInput({
        currentPrice: 100,
        nearestSupport: 80,
        nearestResistance: 130,
      }));
      expect(result.technicalScore).toBe(0);
    });

    it('prefers support signal when near both', () => {
      // Near both support and resistance — support wins (+1)
      const result = calculateScreeningScore(makeScreenInput({
        currentPrice: 100,
        nearestSupport: 97,
        nearestResistance: 103,
      }));
      expect(result.technicalScore).toBe(1);
    });

    it('gives 0 when no levels exist', () => {
      const result = calculateScreeningScore(makeScreenInput());
      expect(result.technicalScore).toBe(0);
    });
  });

  describe('growth score (0-2)', () => {
    it('gives +2 for growth > 50%', () => {
      const result = calculateScreeningScore(makeScreenInput({ epsGrowthPct: 60 }));
      expect(result.growthScore).toBe(2);
    });

    it('gives +1 for growth > 30%', () => {
      const result = calculateScreeningScore(makeScreenInput({ epsGrowthPct: 40 }));
      expect(result.growthScore).toBe(1);
    });

    it('gives 0 for growth <= 30%', () => {
      const result = calculateScreeningScore(makeScreenInput({ epsGrowthPct: 20 }));
      expect(result.growthScore).toBe(0);
    });

    it('gives 0 for null growth', () => {
      const result = calculateScreeningScore(makeScreenInput({ epsGrowthPct: null }));
      expect(result.growthScore).toBe(0);
    });

    it('gives 0 for negative growth', () => {
      const result = calculateScreeningScore(makeScreenInput({ epsGrowthPct: -10 }));
      expect(result.growthScore).toBe(0);
    });
  });

  describe('composite score', () => {
    it('sums all three components', () => {
      const result = calculateScreeningScore(makeScreenInput({
        pegRating: 'CHEAP',     // 3
        currentPrice: 100,
        nearestSupport: 97,     // +1
        epsGrowthPct: 60,       // +2
      }));

      expect(result.compositeScore).toBe(6); // max possible
    });

    it('can go negative (PRICEY + near resistance + no growth)', () => {
      const result = calculateScreeningScore(makeScreenInput({
        pegRating: 'PRICEY',       // 0
        currentPrice: 100,
        nearestResistance: 103,    // -1
        epsGrowthPct: 5,           // 0
      }));

      expect(result.compositeScore).toBe(-1); // min possible
    });

    it('range is [-1, 6]', () => {
      // Max
      const max = calculateScreeningScore(makeScreenInput({
        pegRating: 'CHEAP', currentPrice: 100, nearestSupport: 97, epsGrowthPct: 60,
      }));
      expect(max.compositeScore).toBe(6);

      // Min
      const min = calculateScreeningScore(makeScreenInput({
        pegRating: 'PRICEY', currentPrice: 100, nearestResistance: 103,
      }));
      expect(min.compositeScore).toBe(-1);
    });
  });
});
