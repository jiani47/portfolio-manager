import { describe, it, expect } from 'vitest';
import {
  computeBeta,
  decomposeAttribution,
  calculatePositionContribution,
  type DailyReturn,
  type AttributionInput,
  type AttributionResult,
  type PositionAttribution,
} from './attribution';

describe('computeBeta', () => {
  it('returns 1.0 when portfolio matches benchmark perfectly', () => {
    const returns: DailyReturn[] = [
      { date: '2026-01-01', portfolioReturn: 0.01, benchmarkReturn: 0.01 },
      { date: '2026-01-02', portfolioReturn: -0.005, benchmarkReturn: -0.005 },
      { date: '2026-01-03', portfolioReturn: 0.02, benchmarkReturn: 0.02 },
    ];

    // Perfect correlation, same magnitude → beta = 1.0
    expect(computeBeta(returns)).toBeCloseTo(1.0, 2);
  });

  it('returns ~2.0 when portfolio moves 2x benchmark', () => {
    const returns: DailyReturn[] = [];
    for (let i = 0; i < 20; i++) {
      const benchRet = (Math.sin(i) * 0.02); // oscillating returns
      returns.push({
        date: `2026-01-${String(i + 1).padStart(2, '0')}`,
        portfolioReturn: benchRet * 2,
        benchmarkReturn: benchRet,
      });
    }

    expect(computeBeta(returns)).toBeCloseTo(2.0, 1);
  });

  it('returns 1.0 for insufficient data (<10 points)', () => {
    const returns = [
      { date: '2026-01-01', portfolioReturn: 0.01, benchmarkReturn: 0.005 },
    ];
    expect(computeBeta(returns)).toBe(1.0);
  });

  it('returns 1.0 when benchmark has zero variance', () => {
    const returns: DailyReturn[] = [];
    for (let i = 0; i < 15; i++) {
      returns.push({
        date: `2026-01-${String(i + 1).padStart(2, '0')}`,
        portfolioReturn: 0.01 * i,
        benchmarkReturn: 0.01, // constant
      });
    }
    expect(computeBeta(returns)).toBe(1.0);
  });
});

describe('decomposeAttribution', () => {
  it('decomposes gap into beta + sector + selection', () => {
    const input: AttributionInput = {
      portfolioReturn: 0.15,     // +15%
      benchmarkReturn: 0.10,     // +10%
      portfolioBeta: 1.3,
      sectorWeights: [
        { sector: 'Technology', portfolioWeight: 0.60, benchmarkWeight: 0.50, sectorReturn: 0.20 },
        { sector: 'Healthcare', portfolioWeight: 0.20, benchmarkWeight: 0.15, sectorReturn: 0.05 },
      ],
    };

    const result = decomposeAttribution(input);

    // Beta effect: (1.3 - 1) × 0.10 = 0.03
    expect(result.betaEffect).toBeCloseTo(0.03, 4);

    // Sector: (0.60-0.50)×(0.20-0.10) + (0.20-0.15)×(0.05-0.10)
    //       = 0.10 × 0.10 + 0.05 × (-0.05) = 0.01 - 0.0025 = 0.0075
    expect(result.sectorAllocation).toBeCloseTo(0.0075, 4);

    // Selection: gap - beta - sector = 0.05 - 0.03 - 0.0075 = 0.0125
    expect(result.stockSelection).toBeCloseTo(0.05 - 0.03 - 0.0075, 4);

    // Components should sum to gap
    const gap = input.portfolioReturn - input.benchmarkReturn;
    expect(result.betaEffect + result.sectorAllocation + result.stockSelection).toBeCloseTo(gap, 6);
  });

  it('handles underperformance (negative gap)', () => {
    const result = decomposeAttribution({
      portfolioReturn: 0.05,
      benchmarkReturn: 0.10,
      portfolioBeta: 0.8,
      sectorWeights: [],
    });

    // Beta effect: (0.8 - 1) × 0.10 = -0.02
    expect(result.betaEffect).toBeCloseTo(-0.02, 4);
    // Gap = -0.05, sector = 0, selection = -0.05 - (-0.02) = -0.03
    expect(result.stockSelection).toBeCloseTo(-0.03, 4);
  });

  it('returns zero gap when portfolio matches benchmark', () => {
    const result = decomposeAttribution({
      portfolioReturn: 0.10,
      benchmarkReturn: 0.10,
      portfolioBeta: 1.0,
      sectorWeights: [],
    });

    expect(result.gap).toBe(0);
    expect(result.betaEffect).toBe(0);
    expect(result.sectorAllocation).toBe(0);
    expect(result.stockSelection).toBe(0);
  });
});

describe('calculatePositionContribution', () => {
  it('calculates excess return × weight', () => {
    const positions: PositionAttribution[] = [
      { symbol: 'AAPL', weight: 0.30, positionReturn: 0.20 },
      { symbol: 'GOOG', weight: 0.40, positionReturn: 0.05 },
      { symbol: 'TSLA', weight: 0.30, positionReturn: -0.10 },
    ];

    const result = calculatePositionContribution(positions, 0.10);

    // AAPL: 0.30 × (0.20 - 0.10) = +0.030
    // GOOG: 0.40 × (0.05 - 0.10) = -0.020
    // TSLA: 0.30 × (-0.10 - 0.10) = -0.060
    const aapl = result.find(r => r.symbol === 'AAPL')!;
    expect(aapl.contribution).toBeCloseTo(0.030, 4);
    expect(aapl.excessReturn).toBeCloseTo(0.10, 4);

    const tsla = result.find(r => r.symbol === 'TSLA')!;
    expect(tsla.contribution).toBeCloseTo(-0.060, 4);
  });

  it('sorts by contribution ascending (worst first)', () => {
    const result = calculatePositionContribution([
      { symbol: 'A', weight: 0.5, positionReturn: 0.20 },
      { symbol: 'B', weight: 0.5, positionReturn: -0.10 },
    ], 0.10);

    expect(result[0].symbol).toBe('B'); // worst
    expect(result[1].symbol).toBe('A'); // best
  });

  it('returns empty for empty positions', () => {
    expect(calculatePositionContribution([], 0.10)).toHaveLength(0);
  });
});
