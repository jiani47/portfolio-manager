/**
 * Valuation calculations — PE, PEG, fair price range, EPS growth.
 * Pure functions, no DB or API dependency.
 */

export type PegRating = 'CHEAP' | 'FAIR' | 'RICH' | 'PRICEY';

/**
 * Assign a PEG rating based on forward PEG value.
 *   CHEAP:  < 0.8
 *   FAIR:   0.8–1.2
 *   RICH:   1.2–2.0
 *   PRICEY: >= 2.0
 */
export function getPegRating(forwardPeg: number | null | undefined): PegRating | null {
  if (forwardPeg == null || forwardPeg <= 0) return null;
  if (forwardPeg < 0.8) return 'CHEAP';
  if (forwardPeg < 1.2) return 'FAIR';
  if (forwardPeg < 2.0) return 'RICH';
  return 'PRICEY';
}

export interface FairPriceRangeInput {
  eps: number | null;
  pe: number | null;
  epsGrowthPct: number | null;
  isAdr: boolean;
}

export interface FairPriceRange {
  fairLow: number;
  fairMid: number;
  fairHigh: number;
}

/**
 * Compute fair price range from EPS and PE.
 *
 * Growth stocks (PE > 30): 75/90/110% of base (EPS × PE)
 * Value stocks (PE <= 30): 85/100/115% of base
 *
 * For domestic stocks with positive EPS growth, PEG=1 price
 * (EPS × growth%) can raise the ceiling above fairHigh.
 *
 * ADRs skip the PEG=1 ceiling adjustment because forward EPS
 * is in local currency while price is in USD.
 */
export function calculateFairPriceRange(input: FairPriceRangeInput): FairPriceRange | null {
  const { eps, pe, epsGrowthPct, isAdr } = input;

  if (eps == null || pe == null || pe <= 0 || eps <= 0) return null;

  const base = eps * pe;
  const isGrowth = pe > 30;

  let fairLow: number;
  let fairMid: number;
  let fairHigh: number;

  if (isGrowth) {
    fairLow = base * 0.75;
    fairMid = base * 0.90;
    fairHigh = base * 1.10;
  } else {
    fairLow = base * 0.85;
    fairMid = base * 1.0;
    fairHigh = base * 1.15;
  }

  // PEG=1 ceiling: for domestic stocks with positive growth
  if (!isAdr && epsGrowthPct != null && epsGrowthPct > 0) {
    const peg1Price = eps * epsGrowthPct;
    if (peg1Price > fairHigh) {
      fairHigh = peg1Price;
    }
  }

  return { fairLow, fairMid, fairHigh };
}

/**
 * YoY EPS growth: (next - current) / current × 100
 */
export function calculateEpsGrowth(
  currentEps: number | null,
  nextEps: number | null,
): number | null {
  if (currentEps == null || nextEps == null || currentEps === 0) return null;
  return ((nextEps - currentEps) / currentEps) * 100;
}

/**
 * Forward PE = price / forward EPS
 */
export function calculateForwardPe(
  price: number,
  forwardEps: number | null,
): number | null {
  if (forwardEps == null || forwardEps === 0) return null;
  return price / forwardEps;
}

/**
 * Derive trailing EPS from price and trailing PE: price / PE
 */
export function calculateTrailingEps(
  price: number,
  trailingPe: number | null,
): number | null {
  if (trailingPe == null || trailingPe === 0) return null;
  return price / trailingPe;
}
