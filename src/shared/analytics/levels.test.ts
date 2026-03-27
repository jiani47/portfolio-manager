import { describe, it, expect } from 'vitest';
import {
  detectSwingPoints,
  clusterLevels,
  scoreLevelStrength,
  computeSupportResistance,
  type OHLCVBar,
  type SwingPoint,
  type PriceLevel,
} from './levels';

// Helper: generate simple OHLCV bars
function bar(i: number, high: number, low: number, close?: number, volume = 1000): OHLCVBar {
  return {
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open: close ?? (high + low) / 2,
    high,
    low,
    close: close ?? (high + low) / 2,
    volume,
  };
}

describe('detectSwingPoints', () => {
  it('detects a swing high when bar high is highest in window', () => {
    // Window=5: bars 0-4 low, bar 5 peak, bars 6-10 low
    const bars: OHLCVBar[] = [];
    for (let i = 0; i < 11; i++) {
      if (i === 5) {
        bars.push(bar(i, 120, 115, 118));
      } else {
        bars.push(bar(i, 105, 100, 102));
      }
    }

    const points = detectSwingPoints(bars, 5);
    const highs = points.filter(p => p.type === 'high');
    expect(highs.length).toBeGreaterThanOrEqual(1);
    expect(highs[0].price).toBe(120);
  });

  it('detects a swing low when bar low is lowest in window', () => {
    const bars: OHLCVBar[] = [];
    for (let i = 0; i < 11; i++) {
      if (i === 5) {
        bars.push(bar(i, 105, 80, 82));
      } else {
        bars.push(bar(i, 105, 100, 102));
      }
    }

    const points = detectSwingPoints(bars, 5);
    const lows = points.filter(p => p.type === 'low');
    expect(lows.length).toBeGreaterThanOrEqual(1);
    expect(lows[0].price).toBe(80);
  });

  it('computes rejection for swing highs (upper wick)', () => {
    const bars: OHLCVBar[] = [];
    for (let i = 0; i < 11; i++) {
      if (i === 5) {
        // High=120, close=110 → rejection = (120-110)/120 = 8.3%
        bars.push({ date: `2026-01-06`, open: 112, high: 120, low: 108, close: 110, volume: 1000 });
      } else {
        bars.push(bar(i, 105, 100, 102));
      }
    }

    const points = detectSwingPoints(bars, 5);
    const high = points.find(p => p.type === 'high');
    expect(high).toBeDefined();
    expect(high!.rejection).toBeCloseTo((120 - 112) / 120, 2); // max(close,open)=112
  });

  it('returns empty for insufficient data', () => {
    const bars = [bar(0, 100, 95), bar(1, 102, 96)];
    expect(detectSwingPoints(bars, 5)).toHaveLength(0);
  });
});

describe('clusterLevels', () => {
  it('clusters points within 2% tolerance', () => {
    const points: SwingPoint[] = [
      { index: 0, price: 100, volume: 1000, rejection: 0.02, type: 'high', date: '2026-01-01' },
      { index: 5, price: 101, volume: 1200, rejection: 0.03, type: 'high', date: '2026-01-06' },
      { index: 10, price: 120, volume: 800, rejection: 0.01, type: 'high', date: '2026-01-11' },
    ];

    const clusters = clusterLevels(points, 0.02);
    // 100 and 101 should cluster (1% apart); 120 is separate
    expect(clusters).toHaveLength(2);
    // Cluster 1: avg of 100 and 101 = 100.5
    const c1 = clusters.find(c => c.price < 110)!;
    expect(c1.price).toBeCloseTo(100.5, 1);
    expect(c1.touches).toBe(2);
  });

  it('keeps distant points separate', () => {
    const points: SwingPoint[] = [
      { index: 0, price: 100, volume: 1000, rejection: 0.02, type: 'high', date: '2026-01-01' },
      { index: 5, price: 110, volume: 1000, rejection: 0.02, type: 'high', date: '2026-01-06' },
    ];

    const clusters = clusterLevels(points, 0.02);
    expect(clusters).toHaveLength(2);
  });

  it('returns empty for empty input', () => {
    expect(clusterLevels([], 0.02)).toHaveLength(0);
  });
});

describe('scoreLevelStrength', () => {
  it('scores higher for more touches', () => {
    const s1 = scoreLevelStrength({ touches: 1, avgVolume: 1000, avgSymbolVolume: 1000, bestRecencyDays: 10, avgRejection: 0.02 });
    const s4 = scoreLevelStrength({ touches: 4, avgVolume: 1000, avgSymbolVolume: 1000, bestRecencyDays: 10, avgRejection: 0.02 });
    expect(s4).toBeGreaterThan(s1);
  });

  it('scores higher for more recent levels', () => {
    const recent = scoreLevelStrength({ touches: 2, avgVolume: 1000, avgSymbolVolume: 1000, bestRecencyDays: 5, avgRejection: 0.02 });
    const old = scoreLevelStrength({ touches: 2, avgVolume: 1000, avgSymbolVolume: 1000, bestRecencyDays: 120, avgRejection: 0.02 });
    expect(recent).toBeGreaterThan(old);
  });

  it('scores higher for higher volume', () => {
    const high = scoreLevelStrength({ touches: 2, avgVolume: 3000, avgSymbolVolume: 1000, bestRecencyDays: 30, avgRejection: 0.02 });
    const low = scoreLevelStrength({ touches: 2, avgVolume: 500, avgSymbolVolume: 1000, bestRecencyDays: 30, avgRejection: 0.02 });
    expect(high).toBeGreaterThan(low);
  });

  it('scores higher for stronger rejection', () => {
    const strong = scoreLevelStrength({ touches: 2, avgVolume: 1000, avgSymbolVolume: 1000, bestRecencyDays: 30, avgRejection: 0.04 });
    const weak = scoreLevelStrength({ touches: 2, avgVolume: 1000, avgSymbolVolume: 1000, bestRecencyDays: 30, avgRejection: 0.005 });
    expect(strong).toBeGreaterThan(weak);
  });

  it('returns value between 1 and 10', () => {
    const s = scoreLevelStrength({ touches: 2, avgVolume: 1000, avgSymbolVolume: 1000, bestRecencyDays: 30, avgRejection: 0.02 });
    expect(s).toBeGreaterThanOrEqual(1);
    expect(s).toBeLessThanOrEqual(10);
  });
});

describe('computeSupportResistance', () => {
  it('separates support (below price) and resistance (above price)', () => {
    // Build bars with two clear swing highs and two clear swing lows
    const bars: OHLCVBar[] = [];
    // 30 bars trending around 100, with spikes at specific points
    for (let i = 0; i < 30; i++) {
      if (i === 10) bars.push(bar(i, 90, 85, 87));   // swing low at 85
      else if (i === 15) bars.push(bar(i, 115, 108, 112)); // swing high at 115
      else if (i === 20) bars.push(bar(i, 92, 82, 88));   // swing low at 82
      else if (i === 25) bars.push(bar(i, 120, 112, 116)); // swing high at 120
      else bars.push(bar(i, 105, 98, 100));
    }

    const result = computeSupportResistance(bars, 100);

    // Should have some support levels below 100 and resistance above 100
    for (const s of result.support) {
      expect(s.price).toBeLessThan(100);
    }
    for (const r of result.resistance) {
      expect(r.price).toBeGreaterThan(100);
    }
  });

  it('limits to maxLevels per side', () => {
    const bars: OHLCVBar[] = [];
    for (let i = 0; i < 100; i++) {
      bars.push(bar(i, 100 + (i % 10), 90 + (i % 10), 95 + (i % 10)));
    }

    const result = computeSupportResistance(bars, 95, { maxLevels: 3 });
    expect(result.support.length).toBeLessThanOrEqual(3);
    expect(result.resistance.length).toBeLessThanOrEqual(3);
  });

  it('returns empty for insufficient data', () => {
    const result = computeSupportResistance([bar(0, 100, 95)], 100);
    expect(result.support).toHaveLength(0);
    expect(result.resistance).toHaveLength(0);
  });
});
