/**
 * Weighted beta — per-position and portfolio-level.
 * Pure functions, no DB dependency.
 */

export interface PositionBetaInput {
  symbol: string;
  beta: number;
  marketValue: number;
}

export interface PositionBetaResult {
  symbol: string;
  beta: number;
  weight: number;
  weightedBeta: number;
}

export interface PortfolioBetaInput {
  positions: PositionBetaInput[];
  cashValue: number;
}

export interface PortfolioBetaResult {
  weightedBeta: number;
  weightedBetaWithCash: number;
  positionBetas: PositionBetaResult[];
}

/**
 * Single position weighted beta: beta × (MV / totalEquityMV)
 */
export function calculatePositionWeightedBeta(input: {
  symbol: string;
  beta: number;
  marketValue: number;
  totalEquityValue: number;
}): PositionBetaResult {
  const weight = input.totalEquityValue > 0 ? input.marketValue / input.totalEquityValue : 0;
  return {
    symbol: input.symbol,
    beta: input.beta,
    weight,
    weightedBeta: input.beta * weight,
  };
}

/**
 * Portfolio-level weighted beta.
 *
 * weightedBeta: sum of (beta × equity weight) across positions, weights sum to 1.0
 * weightedBetaWithCash: weightedBeta × (equityMV / totalMV), cash dilutes beta
 */
export function calculatePortfolioBeta(input: PortfolioBetaInput): PortfolioBetaResult {
  const { positions, cashValue } = input;

  const equityMV = positions.reduce((s, p) => s + p.marketValue, 0);
  const totalMV = equityMV + cashValue;

  const positionBetas: PositionBetaResult[] = positions.map((p) => ({
    symbol: p.symbol,
    beta: p.beta,
    weight: equityMV > 0 ? p.marketValue / equityMV : 0,
    weightedBeta: equityMV > 0 ? p.beta * (p.marketValue / equityMV) : 0,
  }));

  // Sort by weight descending
  positionBetas.sort((a, b) => b.weight - a.weight);

  const weightedBeta = positionBetas.reduce((s, p) => s + p.weightedBeta, 0);
  const equityFraction = totalMV > 0 ? equityMV / totalMV : 1;

  return {
    weightedBeta,
    weightedBetaWithCash: weightedBeta * equityFraction,
    positionBetas,
  };
}
