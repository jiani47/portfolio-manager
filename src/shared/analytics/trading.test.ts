import { describe, it, expect } from 'vitest';
import {
  calculateTradeStats,
  calculateOpenPnl,
  type ClosedTradeInput,
  type OpenTradeInput,
  type TradeStatsResult,
} from './trading';

function win(gain: number, holdDays = 30): ClosedTradeInput {
  return { realizedGain: gain, realizedGainPct: (gain / 1000) * 100, holdDays, isWin: true };
}

function loss(gain: number, holdDays = 30): ClosedTradeInput {
  return { realizedGain: gain, realizedGainPct: (gain / 1000) * 100, holdDays, isWin: false };
}

describe('calculateTradeStats', () => {
  describe('win rate', () => {
    it('calculates win rate as wins / total × 100', () => {
      const result = calculateTradeStats([
        win(500), win(300), loss(-200),
      ]);

      expect(result.winRate).toBeCloseTo(66.7, 0);
    });

    it('returns 0 for empty trades', () => {
      expect(calculateTradeStats([]).winRate).toBe(0);
    });

    it('returns 100 for all wins', () => {
      expect(calculateTradeStats([win(100), win(200)]).winRate).toBe(100);
    });

    it('returns 0 for all losses', () => {
      expect(calculateTradeStats([loss(-100), loss(-200)]).winRate).toBe(0);
    });
  });

  describe('counts', () => {
    it('counts total, wins, losses', () => {
      const result = calculateTradeStats([win(100), win(200), loss(-50)]);
      expect(result.totalTrades).toBe(3);
      expect(result.wins).toBe(2);
      expect(result.losses).toBe(1);
    });
  });

  describe('averages', () => {
    it('calculates average win', () => {
      const result = calculateTradeStats([win(500), win(300), loss(-200)]);
      expect(result.avgWin).toBeCloseTo(400, 0); // (500+300)/2
    });

    it('calculates average loss as negative', () => {
      const result = calculateTradeStats([win(500), loss(-200), loss(-100)]);
      expect(result.avgLoss).toBeCloseTo(-150, 0); // -(200+100)/2
    });

    it('returns 0 avgWin when no wins', () => {
      expect(calculateTradeStats([loss(-100)]).avgWin).toBe(0);
    });

    it('returns 0 avgLoss when no losses', () => {
      expect(calculateTradeStats([win(100)]).avgLoss).toBe(0);
    });
  });

  describe('extremes', () => {
    it('finds largest win', () => {
      const result = calculateTradeStats([win(500), win(100), loss(-200)]);
      expect(result.largestWin).toBe(500);
    });

    it('finds largest loss (most negative)', () => {
      const result = calculateTradeStats([win(500), loss(-200), loss(-50)]);
      expect(result.largestLoss).toBe(-200);
    });

    it('returns 0 largestWin when no wins', () => {
      expect(calculateTradeStats([loss(-100)]).largestWin).toBe(0);
    });

    it('returns 0 largestLoss when no losses', () => {
      expect(calculateTradeStats([win(100)]).largestLoss).toBe(0);
    });
  });

  describe('total realized gain', () => {
    it('sums all trade gains', () => {
      const result = calculateTradeStats([win(500), win(300), loss(-200)]);
      expect(result.totalRealizedGain).toBe(600);
    });

    it('returns 0 for empty', () => {
      expect(calculateTradeStats([]).totalRealizedGain).toBe(0);
    });
  });

  describe('profit factor', () => {
    it('is grossWins / grossLosses', () => {
      const result = calculateTradeStats([win(500), win(300), loss(-200), loss(-100)]);
      // grossWins = 800, grossLosses = 300
      expect(result.profitFactor).toBeCloseTo(2.67, 1);
    });

    it('is Infinity when wins but no losses', () => {
      const result = calculateTradeStats([win(500)]);
      expect(result.profitFactor).toBe(Infinity);
    });

    it('is 0 when losses but no wins', () => {
      const result = calculateTradeStats([loss(-200)]);
      expect(result.profitFactor).toBe(0);
    });

    it('is 0 for empty', () => {
      expect(calculateTradeStats([]).profitFactor).toBe(0);
    });
  });

  describe('average R/R', () => {
    it('is abs(avgWin / avgLoss)', () => {
      const result = calculateTradeStats([win(400), win(200), loss(-100), loss(-50)]);
      // avgWin=300, avgLoss=-75 → R/R = 300/75 = 4.0
      expect(result.avgRiskReward).toBeCloseTo(4.0, 1);
    });

    it('is 0 when no losses', () => {
      expect(calculateTradeStats([win(100)]).avgRiskReward).toBe(0);
    });

    it('is 0 when no wins', () => {
      expect(calculateTradeStats([loss(-100)]).avgRiskReward).toBe(0);
    });
  });
});

describe('calculateOpenPnl', () => {
  it('calculates unrealized P&L per trade', () => {
    const results = calculateOpenPnl([
      { shares: 100, entryPrice: 50, currentPrice: 60 },
    ]);

    expect(results[0].unrealizedGain).toBe(1000);   // 100 * (60-50)
    expect(results[0].unrealizedGainPct).toBeCloseTo(20, 1); // (60-50)/50 * 100
  });

  it('handles losing positions', () => {
    const results = calculateOpenPnl([
      { shares: 50, entryPrice: 100, currentPrice: 80 },
    ]);

    expect(results[0].unrealizedGain).toBe(-1000);  // 50 * (80-100)
    expect(results[0].unrealizedGainPct).toBeCloseTo(-20, 1);
  });

  it('sums total open P&L', () => {
    const results = calculateOpenPnl([
      { shares: 100, entryPrice: 50, currentPrice: 60 },  // +1000
      { shares: 50, entryPrice: 100, currentPrice: 80 },  // -1000
    ]);

    const total = results.reduce((s, r) => s + r.unrealizedGain, 0);
    expect(total).toBe(0);
  });

  it('returns empty for no trades', () => {
    expect(calculateOpenPnl([])).toHaveLength(0);
  });

  it('falls back to entryPrice when currentPrice is null', () => {
    const results = calculateOpenPnl([
      { shares: 100, entryPrice: 50, currentPrice: null },
    ]);

    expect(results[0].unrealizedGain).toBe(0);
    expect(results[0].unrealizedGainPct).toBe(0);
  });
});
