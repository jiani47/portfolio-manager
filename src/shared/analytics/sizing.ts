/**
 * Position sizing — tier limits, ATR-adjusted tranches, S/R-based entries.
 * Pure functions, no DB dependency.
 */

const TIER_LIMITS: Record<string, number> = {
  Core: 25,
  Growth: 10,
  Starter: 5,
};

const DEFAULT_LIMIT = 5;
const DEFAULT_DIP_PCT = 3;

export function getTierLimit(tier: string): number {
  return TIER_LIMITS[tier] ?? DEFAULT_LIMIT;
}

export interface SizingInput {
  currentPrice: number;
  currentShares: number;
  portfolioTotal: number;
  tier: string;
  targetPctOverride: number | null;
}

export interface SizingResult {
  tierLimitPct: number;
  currentMarketValue: number;
  currentPct: number;
  targetMarketValue: number;
  targetShares: number;
  roomMarketValue: number;
  roomShares: number;
}

export function calculatePositionSize(input: SizingInput): SizingResult {
  const { currentPrice, currentShares, portfolioTotal, tier, targetPctOverride } = input;

  const tierLimitPct = targetPctOverride ?? getTierLimit(tier);
  const currentMarketValue = currentShares * currentPrice;
  const currentPct = portfolioTotal > 0 ? (currentMarketValue / portfolioTotal) * 100 : 0;
  const targetMarketValue = (tierLimitPct / 100) * portfolioTotal;
  const targetShares = currentPrice > 0 ? Math.floor(targetMarketValue / currentPrice) : 0;
  const roomMarketValue = Math.max(0, targetMarketValue - currentMarketValue);
  const roomShares = currentPrice > 0 ? Math.max(0, Math.floor(roomMarketValue / currentPrice)) : 0;

  return {
    tierLimitPct,
    currentMarketValue,
    currentPct,
    targetMarketValue,
    targetShares,
    roomMarketValue,
    roomShares,
  };
}

export interface TrancheInput {
  addShares: number;
  currentPrice: number;
  atrPct: number;
  supportLevels: number[]; // sorted nearest first: [S1, S2]
}

export interface Tranche {
  shares: number;
  entryPrice: number;
  dipPct: number;
  label: string;
}

/**
 * ATR volatility → tranche weight allocation:
 *   High (>4%): 15/35/50 — load more at deeper support
 *   Medium (2-4%): 20/30/50
 *   Low (<2%): 25/25/50
 */
function getWeights(atrPct: number): [number, number] {
  if (atrPct > 4) return [0.15, 0.35];
  if (atrPct > 2) return [0.20, 0.30];
  return [0.25, 0.25];
}

export function calculateTranches(input: TrancheInput): Tranche[] {
  const { addShares, currentPrice, atrPct, supportLevels } = input;

  if (addShares <= 0) return [];

  // For very small share counts, reduce tranche count
  if (addShares === 1) {
    const price = supportLevels[0] ?? currentPrice;
    const dipPct = currentPrice > 0 ? ((currentPrice - price) / currentPrice) * 100 : 0;
    return [{
      shares: 1,
      entryPrice: price,
      dipPct,
      label: supportLevels.length > 0 ? 'S1' : 'now',
    }];
  }

  if (addShares === 2) {
    const s1 = supportLevels[0];
    if (s1 != null) {
      const dipPct = currentPrice > 0 ? ((currentPrice - s1) / currentPrice) * 100 : 0;
      return [
        { shares: 1, entryPrice: s1, dipPct, label: 'S1' },
        { shares: 1, entryPrice: currentPrice, dipPct: 0, label: 'thesis confirm' },
      ];
    }
    return [
      { shares: 1, entryPrice: currentPrice, dipPct: 0, label: 'now' },
      { shares: 1, entryPrice: currentPrice * (1 - (atrPct || DEFAULT_DIP_PCT) / 100), dipPct: atrPct || DEFAULT_DIP_PCT, label: 'dip 1' },
    ];
  }

  const [w1, w2] = getWeights(atrPct);
  const hasSR = supportLevels.length > 0;
  const dipFallback = atrPct || DEFAULT_DIP_PCT;

  let t1Shares = Math.max(1, Math.floor(addShares * w1));
  let t2Shares = Math.max(1, Math.floor(addShares * w2));
  const t3Shares = addShares - t1Shares - t2Shares;

  // Ensure t3 is at least 1 by borrowing from t2 if needed
  if (t3Shares < 1) {
    t2Shares = Math.max(1, addShares - t1Shares - 1);
    // Recalculate if still off
  }

  let t1Price: number, t2Price: number, t3Price: number;
  let t1Label: string, t2Label: string, t3Label: string;

  if (hasSR && supportLevels.length >= 2) {
    // Both S1 and S2 available
    t1Price = supportLevels[0];
    t2Price = supportLevels[1];
    t3Price = currentPrice;
    t1Label = 'S1';
    t2Label = 'S2';
    t3Label = 'thesis confirm';
  } else if (hasSR && supportLevels.length === 1) {
    // Only S1 — use ATR dip for T2
    t1Price = supportLevels[0];
    t2Price = currentPrice * (1 - (dipFallback * 2) / 100);
    t3Price = currentPrice;
    t1Label = 'S1';
    t2Label = 'dip 2';
    t3Label = 'thesis confirm';
  } else {
    // No S/R — ATR-based dips
    t1Price = currentPrice;
    t2Price = currentPrice * (1 - dipFallback / 100);
    t3Price = currentPrice * (1 - (dipFallback * 2) / 100);
    t1Label = 'now';
    t2Label = 'dip 1';
    t3Label = 'dip 2';
  }

  const dipPct = (price: number) =>
    currentPrice > 0 ? ((currentPrice - price) / currentPrice) * 100 : 0;

  return [
    { shares: t1Shares, entryPrice: t1Price, dipPct: dipPct(t1Price), label: t1Label },
    { shares: t2Shares, entryPrice: t2Price, dipPct: dipPct(t2Price), label: t2Label },
    { shares: addShares - t1Shares - t2Shares, entryPrice: t3Price, dipPct: dipPct(t3Price), label: t3Label },
  ];
}
