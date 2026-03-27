/**
 * Factor attribution — decompose portfolio return vs benchmark.
 * Pure functions, no DB dependency.
 */

export interface DailyReturn {
  date: string;
  portfolioReturn: number;
  benchmarkReturn: number;
}

export interface SectorWeight {
  sector: string;
  portfolioWeight: number;
  benchmarkWeight: number;
  sectorReturn: number;
}

export interface AttributionInput {
  portfolioReturn: number;
  benchmarkReturn: number;
  portfolioBeta: number;
  sectorWeights: SectorWeight[];
}

export interface AttributionResult {
  gap: number;
  betaEffect: number;
  sectorAllocation: number;
  stockSelection: number;
}

export interface PositionAttribution {
  symbol: string;
  weight: number;
  positionReturn: number;
}

export interface PositionContribution {
  symbol: string;
  weight: number;
  positionReturn: number;
  excessReturn: number;
  contribution: number;
}

/**
 * Compute portfolio beta vs benchmark using covariance / variance.
 * Returns 1.0 for insufficient data (<10 points) or zero benchmark variance.
 */
export function computeBeta(returns: DailyReturn[]): number {
  if (returns.length < 10) return 1.0;

  const n = returns.length;
  const pVals = returns.map(r => r.portfolioReturn);
  const bVals = returns.map(r => r.benchmarkReturn);

  const mp = pVals.reduce((s, v) => s + v, 0) / n;
  const mb = bVals.reduce((s, v) => s + v, 0) / n;

  let covariance = 0;
  let varianceBench = 0;

  for (let i = 0; i < n; i++) {
    covariance += (pVals[i] - mp) * (bVals[i] - mb);
    varianceBench += (bVals[i] - mb) ** 2;
  }

  if (varianceBench <= 0) return 1.0;
  return covariance / varianceBench;
}

/**
 * Decompose tracking error into three additive components:
 *   Gap = Beta Effect + Sector Allocation + Stock Selection
 *
 * Beta Effect: (portfolio_beta - 1) × benchmark_return
 * Sector Allocation: Σ (port_weight - bench_weight) × (sector_return - bench_return)
 * Stock Selection: residual (gap - beta - sector)
 */
export function decomposeAttribution(input: AttributionInput): AttributionResult {
  const { portfolioReturn, benchmarkReturn, portfolioBeta, sectorWeights } = input;

  const gap = portfolioReturn - benchmarkReturn;
  const betaEffect = (portfolioBeta - 1) * benchmarkReturn;

  let sectorAllocation = 0;
  for (const sw of sectorWeights) {
    sectorAllocation += (sw.portfolioWeight - sw.benchmarkWeight) * (sw.sectorReturn - benchmarkReturn);
  }

  const stockSelection = gap - betaEffect - sectorAllocation;

  return { gap, betaEffect, sectorAllocation, stockSelection };
}

/**
 * Per-position contribution: excess_return × weight, sorted worst to best.
 */
export function calculatePositionContribution(
  positions: PositionAttribution[],
  benchmarkReturn: number,
): PositionContribution[] {
  return positions
    .map(p => {
      const excessReturn = p.positionReturn - benchmarkReturn;
      return {
        symbol: p.symbol,
        weight: p.weight,
        positionReturn: p.positionReturn,
        excessReturn,
        contribution: p.weight * excessReturn,
      };
    })
    .sort((a, b) => a.contribution - b.contribution);
}
