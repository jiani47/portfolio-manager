import { describe, it, expect } from 'vitest';
import {
  computeCorrelation,
  computeAutocorrelation,
  computeDailyReturns,
  classifyRegime,
} from '../regime';

describe('computeCorrelation', () => {
  it('returns 1 for perfectly correlated series', () => {
    const a = [1, 2, 3, 4, 5];
    const b = [2, 4, 6, 8, 10];
    expect(computeCorrelation(a, b)).toBeCloseTo(1, 5);
  });

  it('returns -1 for perfectly inverse series', () => {
    const a = [1, 2, 3, 4, 5];
    const b = [10, 8, 6, 4, 2];
    expect(computeCorrelation(a, b)).toBeCloseTo(-1, 5);
  });

  it('returns near 0 for uncorrelated series', () => {
    const a = [1, -1, 1, -1, 1, -1, 1, -1];
    const b = [1, 1, -1, -1, 1, 1, -1, -1];
    const r = computeCorrelation(a, b);
    expect(Math.abs(r)).toBeLessThan(0.3);
  });

  it('returns 0 for insufficient data', () => {
    expect(computeCorrelation([1], [2])).toBe(0);
    expect(computeCorrelation([], [])).toBe(0);
  });

  it('returns 0 for zero variance series', () => {
    expect(computeCorrelation([5, 5, 5], [1, 2, 3])).toBe(0);
  });
});

describe('computeAutocorrelation', () => {
  it('returns high positive for trending series', () => {
    // Monotonically increasing returns → positive autocorrelation
    const returns = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09];
    const ac = computeAutocorrelation(returns);
    expect(ac).toBeGreaterThan(0.5);
  });

  it('returns negative for alternating (mean-reverting) series', () => {
    const returns = [0.05, -0.05, 0.05, -0.05, 0.05, -0.05, 0.05, -0.05];
    const ac = computeAutocorrelation(returns);
    expect(ac).toBeLessThan(-0.5);
  });

  it('is much lower for unstructured series than for trending', () => {
    const trending = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09];
    const unstructured = [0.02, -0.01, 0.03, -0.02, 0.01, 0.04, -0.03, 0.01, -0.01];
    const acTrending = computeAutocorrelation(trending);
    const acUnstructured = computeAutocorrelation(unstructured);
    expect(acTrending).toBeGreaterThan(acUnstructured);
  });

  it('returns 0 for insufficient data', () => {
    expect(computeAutocorrelation([0.01, 0.02])).toBe(0); // need lag + 2 = 3
    expect(computeAutocorrelation([0.01])).toBe(0);
    expect(computeAutocorrelation([])).toBe(0);
  });

  it('supports custom lag', () => {
    const returns = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07];
    const ac1 = computeAutocorrelation(returns, 1);
    const ac2 = computeAutocorrelation(returns, 2);
    // Both should be positive for trending, but lag-2 needs more data
    expect(ac1).toBeGreaterThan(0);
    expect(ac2).toBeGreaterThan(0);
  });
});

describe('computeDailyReturns', () => {
  it('computes simple returns from prices', () => {
    const prices = [100, 105, 110];
    const returns = computeDailyReturns(prices);
    expect(returns).toHaveLength(2);
    expect(returns[0]).toBeCloseTo(0.05, 5);
    expect(returns[1]).toBeCloseTo(0.0476, 3); // 5/105
  });

  it('handles single price', () => {
    expect(computeDailyReturns([100])).toHaveLength(0);
  });

  it('skips zero prices', () => {
    const prices = [0, 100, 105];
    const returns = computeDailyReturns(prices);
    expect(returns).toHaveLength(1); // only 100→105
  });
});

describe('classifyRegime', () => {
  it('classifies as trend when all sectors move with SPY', () => {
    // All sectors have returns perfectly correlated with SPY
    const spyReturns = [0.01, 0.02, -0.01, 0.03, 0.01, -0.02, 0.02, 0.01, 0.03];
    const sectorReturns: Record<string, number[]> = {};
    const sectorNames: Record<string, string> = {};

    // 11 sectors all tracking SPY closely (with slight noise)
    const symbols = ['XLK', 'XLF', 'XLV', 'XLE', 'XLI', 'XLY', 'XLP', 'XLU', 'XLRE', 'XLB', 'XLC'];
    const names = ['Tech', 'Fin', 'Health', 'Energy', 'Indust', 'ConDisc', 'ConStap', 'Util', 'RE', 'Mat', 'Comm'];

    for (let i = 0; i < symbols.length; i++) {
      // Each sector = SPY * small scale factor (high correlation)
      const scale = 0.8 + Math.random() * 0.4;
      sectorReturns[symbols[i]] = spyReturns.map(r => r * scale);
      sectorNames[symbols[i]] = names[i];
    }

    const result = classifyRegime(sectorReturns, spyReturns, sectorNames);
    expect(result.type).toBe('trend');
    expect(result.correlatedSectorCount).toBeGreaterThanOrEqual(7);
    expect(result.sectorSignals).toHaveLength(11);
    expect(result.summary).toContain('correlated with SPY');
  });

  it('classifies as sorting when sectors diverge', () => {
    const spyReturns = [0.01, -0.01, 0.01, -0.01, 0.01, -0.01, 0.01, -0.01, 0.01];
    const sectorReturns: Record<string, number[]> = {};
    const sectorNames: Record<string, string> = {};

    const symbols = ['XLK', 'XLF', 'XLV', 'XLE', 'XLI', 'XLY', 'XLP', 'XLU', 'XLRE', 'XLB', 'XLC'];
    const names = ['Tech', 'Fin', 'Health', 'Energy', 'Indust', 'ConDisc', 'ConStap', 'Util', 'RE', 'Mat', 'Comm'];

    for (let i = 0; i < symbols.length; i++) {
      // Each sector has independent random-looking returns (low correlation with SPY)
      const phase = i * 0.7; // phase shift ensures low correlation
      sectorReturns[symbols[i]] = spyReturns.map((_, j) => Math.sin(j + phase) * 0.02);
      sectorNames[symbols[i]] = names[i];
    }

    const result = classifyRegime(sectorReturns, spyReturns, sectorNames);
    expect(result.type).toBe('sorting');
    expect(result.correlatedSectorCount).toBeLessThan(7);
  });

  it('returns sorting with zero confidence for empty input', () => {
    const result = classifyRegime({}, [], {});
    expect(result.type).toBe('sorting');
    expect(result.confidence).toBe(0);
    expect(result.sectorSignals).toHaveLength(0);
  });

  it('computes dispersion from today returns', () => {
    const spyReturns = [0.01, 0.02, 0.01];
    const sectorReturns: Record<string, number[]> = {
      XLK: [0.02, 0.03, 0.05],  // +5% today
      XLF: [0.01, 0.01, -0.03], // -3% today
    };

    const result = classifyRegime(sectorReturns, spyReturns, { XLK: 'Tech', XLF: 'Fin' });
    // Dispersion should be > 0 because 5% and -3% are different
    expect(result.dispersionPct).toBeGreaterThan(0);
  });

  it('assigns correct quadrants', () => {
    // XLK: high correlation, high autocorrelation → trend-momentum
    // XLF: low correlation, low autocorrelation → noise
    const spyReturns = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09];

    const sectorReturns: Record<string, number[]> = {
      // Perfectly tracks SPY (high corr) and is trending (high auto)
      XLK: [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09],
      // Independent of SPY and mean-reverting
      XLF: [0.05, -0.05, 0.05, -0.05, 0.05, -0.05, 0.05, -0.05, 0.05],
    };

    const result = classifyRegime(sectorReturns, spyReturns, { XLK: 'Tech', XLF: 'Fin' });
    const xlk = result.sectorSignals.find(s => s.symbol === 'XLK')!;
    const xlf = result.sectorSignals.find(s => s.symbol === 'XLF')!;

    expect(xlk.quadrant).toBe('trend-momentum');
    expect(xlf.quadrant).toBe('noise');
  });
});
