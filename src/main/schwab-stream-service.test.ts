import { describe, it, expect } from 'vitest';
import { resolveQuote } from './schwab-stream-service';

describe('resolveQuote', () => {
  // Real Schwab data from user's debug logs:
  // SPY during market hours:
  //   ext.last=642.44 (STALE from Friday after-hours)
  //   reg.last=655.92 (correct current price)
  //   reg.close=648.57 (Friday's close)
  //   reg.open=658.07 (today's open)
  //   reg.mark=655.81

  const spyRegular = {
    lastPrice: 655.92,
    closePrice: 648.57,
    openPrice: 658.07,
    mark: 655.81,
    netChange: 7.35,
    netPercentChange: 1.133,
  };

  const spyExtStale = {
    lastPrice: 642.44,
  };

  describe('during market hours (isPreMarket=false)', () => {
    it('ignores stale ext.lastPrice and uses reg.lastPrice', () => {
      const result = resolveQuote(spyRegular, spyExtStale, false);
      expect(result.last).toBe(655.92);
    });

    it('computes change as last - open', () => {
      const result = resolveQuote(spyRegular, spyExtStale, false);
      expect(result.netChange).toBeCloseTo(655.92 - 658.07, 2);
      expect(result.netChangePct).toBeCloseTo(((655.92 - 658.07) / 658.07) * 100, 2);
    });

    it('change is negative when price dropped from open', () => {
      const result = resolveQuote(spyRegular, spyExtStale, false);
      expect(result.netChange).toBeLessThan(0);
      expect(result.netChangePct).toBeLessThan(0);
    });

    it('uses mark as fallback when reg.lastPrice missing', () => {
      const { lastPrice, ...noLast } = spyRegular;
      const result = resolveQuote(noLast, null, false);
      expect(result.last).toBe(655.81); // mark
    });

    it('uses closePrice as last resort during market hours', () => {
      const result = resolveQuote({ closePrice: 648.57, openPrice: 658.07 }, null, false);
      expect(result.last).toBe(648.57);
    });

    it('still works with no ext quote at all', () => {
      const result = resolveQuote(spyRegular, null, false);
      expect(result.last).toBe(655.92);
    });

    it('still works with undefined ext quote', () => {
      const result = resolveQuote(spyRegular, undefined, false);
      expect(result.last).toBe(655.92);
    });
  });

  describe('pre-market (isPreMarket=true)', () => {
    it('uses ext.lastPrice when available (current pre-market trade)', () => {
      const result = resolveQuote(spyRegular, { lastPrice: 660.00 }, true);
      expect(result.last).toBe(660.00);
    });

    it('falls back to reg.lastPrice when no ext quote', () => {
      const result = resolveQuote(spyRegular, null, true);
      expect(result.last).toBe(655.92);
    });

    it('uses Schwab netChange (vs previous close), not open-based', () => {
      const result = resolveQuote(spyRegular, { lastPrice: 660.00 }, true);
      // Pre-market uses Schwab's netChange directly
      expect(result.netChange).toBe(7.35);
      expect(result.netChangePct).toBe(1.133);
    });
  });

  describe('edge cases', () => {
    it('returns 0 for last when no price data at all', () => {
      const result = resolveQuote({}, null, false);
      expect(result.last).toBe(0);
    });

    it('returns 0 change when no open and no Schwab change', () => {
      const result = resolveQuote({ lastPrice: 100 }, null, false);
      expect(result.netChange).toBe(0);
      expect(result.netChangePct).toBe(0);
    });

    it('uses Schwab netChange when openPrice missing during market hours', () => {
      const result = resolveQuote({
        lastPrice: 100,
        netChange: 2.5,
        netPercentChange: 2.56,
      }, null, false);
      // No openPrice → falls back to Schwab's netChange
      expect(result.netChange).toBe(2.5);
      expect(result.netChangePct).toBe(2.56);
    });

    it('handles positive intraday move correctly', () => {
      const result = resolveQuote({
        lastPrice: 110,
        openPrice: 100,
      }, null, false);
      expect(result.netChange).toBe(10);
      expect(result.netChangePct).toBeCloseTo(10.0, 1);
    });

    it('handles flat day', () => {
      const result = resolveQuote({
        lastPrice: 100,
        openPrice: 100,
      }, null, false);
      expect(result.netChange).toBe(0);
      expect(result.netChangePct).toBe(0);
    });
  });
});
