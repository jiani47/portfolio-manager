/**
 * Regime classification — quantitative trend vs sorting day detection.
 * Pure functions, no DB dependency.
 *
 * Two signals per sector:
 * 1. Sector-Index Correlation: is this sector moving with SPY today?
 * 2. Sector Autocorrelation: is this sector's move continuing a multi-day trend?
 */

// Thresholds for classification (tunable)
export const INDEX_CORR_THRESHOLD = 0.6;
export const AUTO_CORR_THRESHOLD = 0.3;
export const TREND_SECTOR_MIN = 7; // out of 11 sectors

export type Quadrant = 'trend-momentum' | 'risk-toggle' | 'sector-rotation' | 'noise';

export interface SectorRegimeSignal {
  symbol: string;
  sector: string;
  changePct: number;
  indexCorrelation: number;
  autocorrelation: number;
  quadrant: Quadrant;
}

export interface RegimeClassification {
  type: 'trend' | 'sorting';
  confidence: number; // 0-1
  avgIndexCorrelation: number;
  avgAutocorrelation: number;
  dispersionPct: number; // std dev of today's sector returns
  correlatedSectorCount: number;
  totalSectors: number;
  sectorSignals: SectorRegimeSignal[];
  summary: string;
}

/**
 * Pearson correlation between two arrays of equal length.
 * Returns 0 if insufficient data or zero variance.
 */
export function computeCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;

  const meanA = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const meanB = b.slice(0, n).reduce((s, v) => s + v, 0) / n;

  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }

  const denom = Math.sqrt(varA * varB);
  return denom > 0 ? cov / denom : 0;
}

/**
 * Lag-k autocorrelation of a return series.
 * Computes Pearson correlation between returns[0..n-lag-1] and returns[lag..n-1].
 * Returns 0 if insufficient data (need at least lag + 2 points).
 */
export function computeAutocorrelation(returns: number[], lag: number = 1): number {
  if (returns.length < lag + 2) return 0;
  return computeCorrelation(returns.slice(0, -lag), returns.slice(lag));
}

/**
 * Compute daily returns from a price series (oldest first).
 * Returns array of length prices.length - 1.
 */
export function computeDailyReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }
  }
  return returns;
}

function assignQuadrant(indexCorr: number, autoCorr: number): Quadrant {
  const highCorr = Math.abs(indexCorr) >= INDEX_CORR_THRESHOLD;
  const highAuto = autoCorr >= AUTO_CORR_THRESHOLD;

  if (highCorr && highAuto) return 'trend-momentum';
  if (highCorr && !highAuto) return 'risk-toggle';
  if (!highCorr && highAuto) return 'sector-rotation';
  return 'noise';
}

/**
 * Classify the regime from sector and SPY return series.
 *
 * @param sectorReturns - Map of ETF symbol → array of daily returns (oldest first)
 * @param spyReturns - SPY daily returns (oldest first), same length as sector returns
 * @param sectorNames - Map of ETF symbol → human-readable sector name
 */
export function classifyRegime(
  sectorReturns: Record<string, number[]>,
  spyReturns: number[],
  sectorNames: Record<string, string>,
): RegimeClassification {
  const signals: SectorRegimeSignal[] = [];

  for (const [symbol, returns] of Object.entries(sectorReturns)) {
    if (returns.length < 2) continue;

    const indexCorr = computeCorrelation(returns, spyReturns.slice(0, returns.length));
    const autoCorr = computeAutocorrelation(returns);
    const todayReturn = returns[returns.length - 1];

    signals.push({
      symbol,
      sector: sectorNames[symbol] || symbol,
      changePct: todayReturn * 100,
      indexCorrelation: indexCorr,
      autocorrelation: autoCorr,
      quadrant: assignQuadrant(indexCorr, autoCorr),
    });
  }

  if (signals.length === 0) {
    return {
      type: 'sorting',
      confidence: 0,
      avgIndexCorrelation: 0,
      avgAutocorrelation: 0,
      dispersionPct: 0,
      correlatedSectorCount: 0,
      totalSectors: 0,
      sectorSignals: [],
      summary: 'No sector data available',
    };
  }

  // Sort by change % descending
  signals.sort((a, b) => b.changePct - a.changePct);

  const correlatedCount = signals.filter(
    s => Math.abs(s.indexCorrelation) >= INDEX_CORR_THRESHOLD
  ).length;
  const totalSectors = signals.length;

  const avgIndexCorr = signals.reduce((s, v) => s + v.indexCorrelation, 0) / totalSectors;
  const avgAutoCorr = signals.reduce((s, v) => s + v.autocorrelation, 0) / totalSectors;

  // Cross-sectional dispersion: std dev of today's returns
  const todayReturns = signals.map(s => s.changePct);
  const meanReturn = todayReturns.reduce((s, v) => s + v, 0) / todayReturns.length;
  const dispersion = todayReturns.length > 1
    ? Math.sqrt(todayReturns.reduce((s, v) => s + (v - meanReturn) ** 2, 0) / (todayReturns.length - 1))
    : 0;

  const type = correlatedCount >= TREND_SECTOR_MIN ? 'trend' : 'sorting';
  const confidence = type === 'trend'
    ? correlatedCount / totalSectors
    : (totalSectors - correlatedCount) / totalSectors;

  const summary = `${correlatedCount}/${totalSectors} sectors correlated with SPY, dispersion ${dispersion.toFixed(2)}%`;

  return {
    type,
    confidence,
    avgIndexCorrelation: avgIndexCorr,
    avgAutocorrelation: avgAutoCorr,
    dispersionPct: dispersion,
    correlatedSectorCount: correlatedCount,
    totalSectors,
    sectorSignals: signals,
    summary,
  };
}
