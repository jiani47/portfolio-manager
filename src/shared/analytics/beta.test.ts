import { describe, it, expect } from 'vitest';
import {
  calculatePositionWeightedBeta,
  calculatePortfolioBeta,
  type PositionBetaInput,
} from './beta';

describe('calculatePositionWeightedBeta', () => {
  it('computes weighted beta as beta * weight', () => {
    const result = calculatePositionWeightedBeta({
      symbol: 'AAPL',
      beta: 1.2,
      marketValue: 10000,
      totalEquityValue: 100000,
    });

    expect(result.weight).toBeCloseTo(0.10, 4);
    expect(result.weightedBeta).toBeCloseTo(0.12, 4);
  });

  it('handles zero total equity', () => {
    const result = calculatePositionWeightedBeta({
      symbol: 'AAPL',
      beta: 1.2,
      marketValue: 10000,
      totalEquityValue: 0,
    });

    expect(result.weight).toBe(0);
    expect(result.weightedBeta).toBe(0);
  });
});

describe('calculatePortfolioBeta', () => {
  const positions: PositionBetaInput[] = [
    { symbol: 'AAPL', beta: 1.2, marketValue: 50000 },
    { symbol: 'GOOG', beta: 1.1, marketValue: 30000 },
    { symbol: 'JNJ', beta: 0.6, marketValue: 20000 },
  ];

  it('computes equity-weighted portfolio beta', () => {
    const result = calculatePortfolioBeta({ positions, cashValue: 0 });

    // AAPL: 1.2*0.5=0.60, GOOG: 1.1*0.3=0.33, JNJ: 0.6*0.2=0.12
    // Sum = 1.05
    expect(result.weightedBeta).toBeCloseTo(1.05, 2);
  });

  it('computes beta with cash dilution', () => {
    // equity = $100k, cash = $100k, total = $200k
    // equityFraction = 0.5, weightedBetaWithCash = 1.05 * 0.5 = 0.525
    const result = calculatePortfolioBeta({ positions, cashValue: 100000 });

    expect(result.weightedBetaWithCash).toBeCloseTo(0.525, 2);
  });

  it('returns per-position breakdowns', () => {
    const result = calculatePortfolioBeta({ positions, cashValue: 0 });

    expect(result.positionBetas).toHaveLength(3);
    const aapl = result.positionBetas.find(p => p.symbol === 'AAPL')!;
    expect(aapl.weight).toBeCloseTo(0.5, 2);
    expect(aapl.weightedBeta).toBeCloseTo(0.6, 2);
  });

  it('returns sorted by weight descending', () => {
    const result = calculatePortfolioBeta({ positions, cashValue: 0 });
    const weights = result.positionBetas.map(p => p.weight);
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeLessThanOrEqual(weights[i - 1]);
    }
  });

  it('handles empty positions', () => {
    const result = calculatePortfolioBeta({ positions: [], cashValue: 10000 });
    expect(result.weightedBeta).toBe(0);
    expect(result.weightedBetaWithCash).toBe(0);
  });

  it('handles all cash (no equity)', () => {
    const result = calculatePortfolioBeta({ positions: [], cashValue: 50000 });
    expect(result.weightedBeta).toBe(0);
    expect(result.weightedBetaWithCash).toBe(0);
  });

  it('weights sum to 1.0 for equity positions', () => {
    const result = calculatePortfolioBeta({ positions, cashValue: 0 });
    const totalWeight = result.positionBetas.reduce((s, p) => s + p.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 6);
  });
});
