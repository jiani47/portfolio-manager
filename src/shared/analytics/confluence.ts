/**
 * Confluence detection and screening scores.
 * Pure functions — takes pre-fetched data, returns signals and scores.
 */

import type { PegRating } from './valuation';

const SUPPORT_PROXIMITY_PCT = 5;
const RESISTANCE_PROXIMITY_PCT = 5;
const EPS_GROWTH_CONFLUENCE_THRESHOLD = 20;
const EPS_GROWTH_HIGH_THRESHOLD = 50;
const EPS_GROWTH_MED_THRESHOLD = 30;
const CONFLUENCE_MIN_SIGNALS = 2;

export interface ConfluenceInput {
  symbol: string;
  currentPrice: number;
  forwardPeg: number | null;
  pegRating: PegRating | null;
  epsGrowthPct: number | null;
  nearestSupport: number | null;
  nearestResistance: number | null;
}

export interface Signal {
  type: 'valuation' | 'technical' | 'growth';
  label: string;
}

export interface ConfluenceResult {
  symbol: string;
  signals: Signal[];
  signalCount: number;
  hasConfluence: boolean;
}

export function detectConfluenceSignals(input: ConfluenceInput): ConfluenceResult {
  const { symbol, currentPrice, forwardPeg, pegRating, epsGrowthPct, nearestSupport } = input;
  const signals: Signal[] = [];

  // Valuation signal: CHEAP or FAIR with valid forwardPeg < 1.2
  if (
    forwardPeg != null &&
    forwardPeg > 0 &&
    forwardPeg < 1.2 &&
    (pegRating === 'CHEAP' || pegRating === 'FAIR')
  ) {
    signals.push({
      type: 'valuation',
      label: `Valuation: ${pegRating} (PEG ${forwardPeg.toFixed(2)})`,
    });
  }

  // Technical signal: price within 5% of nearest support
  if (nearestSupport != null && currentPrice > 0) {
    const pctFromSupport = ((currentPrice - nearestSupport) / currentPrice) * 100;
    if (pctFromSupport >= 0 && pctFromSupport <= SUPPORT_PROXIMITY_PCT) {
      signals.push({
        type: 'technical',
        label: `Technical: near support $${nearestSupport.toFixed(2)} (${pctFromSupport.toFixed(1)}% away)`,
      });
    }
  }

  // Growth signal: EPS growth > 20%
  if (epsGrowthPct != null && epsGrowthPct > EPS_GROWTH_CONFLUENCE_THRESHOLD) {
    signals.push({
      type: 'growth',
      label: `Growth: EPS +${epsGrowthPct.toFixed(0)}%`,
    });
  }

  return {
    symbol,
    signals,
    signalCount: signals.length,
    hasConfluence: signals.length >= CONFLUENCE_MIN_SIGNALS,
  };
}

// --- Screening Scores ---

const VALUATION_SCORES: Record<string, number> = {
  CHEAP: 3,
  FAIR: 2,
  RICH: 1,
  PRICEY: 0,
};

export interface ScreeningInput {
  symbol: string;
  currentPrice: number;
  pegRating: PegRating | null;
  epsGrowthPct: number | null;
  nearestSupport: number | null;
  nearestResistance: number | null;
}

export interface ScreeningResult {
  symbol: string;
  valuationScore: number;
  technicalScore: number;
  growthScore: number;
  compositeScore: number;
}

export function calculateScreeningScore(input: ScreeningInput): ScreeningResult {
  const { symbol, currentPrice, pegRating, epsGrowthPct, nearestSupport, nearestResistance } = input;

  // Valuation: 0–3
  const valuationScore = pegRating != null ? (VALUATION_SCORES[pegRating] ?? 0) : 0;

  // Technical: -1 to +1
  let technicalScore = 0;
  if (currentPrice > 0) {
    const nearS = nearestSupport != null
      ? ((currentPrice - nearestSupport) / currentPrice) * 100
      : Infinity;
    const nearR = nearestResistance != null
      ? ((nearestResistance - currentPrice) / currentPrice) * 100
      : Infinity;

    if (nearS <= SUPPORT_PROXIMITY_PCT) {
      technicalScore = 1;
    } else if (nearR <= RESISTANCE_PROXIMITY_PCT) {
      technicalScore = -1;
    }
  }

  // Growth: 0–2
  let growthScore = 0;
  if (epsGrowthPct != null && epsGrowthPct > 0) {
    if (epsGrowthPct > EPS_GROWTH_HIGH_THRESHOLD) {
      growthScore = 2;
    } else if (epsGrowthPct > EPS_GROWTH_MED_THRESHOLD) {
      growthScore = 1;
    }
  }

  return {
    symbol,
    valuationScore,
    technicalScore,
    growthScore,
    compositeScore: valuationScore + technicalScore + growthScore,
  };
}
