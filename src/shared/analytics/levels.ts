/**
 * Support/Resistance level computation — swing high/low detection.
 * Pure functions operating on OHLCV price history.
 */

const DEFAULT_WINDOW = 5;
const CLUSTER_THRESHOLD = 0.02; // 2% price tolerance
const RECENCY_HALF_LIFE = 60;   // days
const REJECTION_CALIBRATION = 0.03; // 3% wick = max score

export interface OHLCVBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SwingPoint {
  index: number;
  price: number;
  volume: number;
  rejection: number;
  type: 'high' | 'low';
  date: string;
}

export interface ClusteredLevel {
  price: number;
  touches: number;
  avgVolume: number;
  avgRejection: number;
  bestRecencyIndex: number; // most recent point's index
  type: 'high' | 'low';
}

export interface PriceLevel {
  price: number;
  strength: number;
  type: 'support' | 'resistance';
}

export interface StrengthInput {
  touches: number;
  avgVolume: number;
  avgSymbolVolume: number;
  bestRecencyDays: number;
  avgRejection: number;
}

/**
 * Detect swing highs/lows using windowed local extrema.
 * Window=5 means we check ±5 bars around each candidate.
 */
export function detectSwingPoints(bars: OHLCVBar[], window = DEFAULT_WINDOW): SwingPoint[] {
  const points: SwingPoint[] = [];
  if (bars.length < window * 2 + 1) return points;

  for (let i = window; i < bars.length - window; i++) {
    const current = bars[i];

    // Check swing high
    let isSwingHigh = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (bars[j].high > current.high) {
        isSwingHigh = false;
        break;
      }
    }

    if (isSwingHigh) {
      const bodyTop = Math.max(current.close, current.open);
      const rejection = current.high > 0 ? (current.high - bodyTop) / current.high : 0;
      points.push({
        index: i,
        price: current.high,
        volume: current.volume,
        rejection,
        type: 'high',
        date: current.date,
      });
    }

    // Check swing low
    let isSwingLow = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (bars[j].low < current.low) {
        isSwingLow = false;
        break;
      }
    }

    if (isSwingLow) {
      const bodyBottom = Math.min(current.close, current.open);
      const rejection = current.low > 0 ? (bodyBottom - current.low) / current.low : 0;
      points.push({
        index: i,
        price: current.low,
        volume: current.volume,
        rejection,
        type: 'low',
        date: current.date,
      });
    }
  }

  return points;
}

/**
 * Cluster nearby swing points within threshold tolerance.
 * Returns averaged price per cluster with touch count.
 */
export function clusterLevels(points: SwingPoint[], threshold = CLUSTER_THRESHOLD): ClusteredLevel[] {
  if (points.length === 0) return [];

  // Sort by price
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters: ClusteredLevel[] = [];
  let cluster: SwingPoint[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = cluster[cluster.length - 1];
    if ((sorted[i].price - prev.price) / prev.price <= threshold) {
      cluster.push(sorted[i]);
    } else {
      clusters.push(buildCluster(cluster));
      cluster = [sorted[i]];
    }
  }
  clusters.push(buildCluster(cluster));

  return clusters;
}

function buildCluster(points: SwingPoint[]): ClusteredLevel {
  const avgPrice = points.reduce((s, p) => s + p.price, 0) / points.length;
  const avgVolume = points.reduce((s, p) => s + p.volume, 0) / points.length;
  const avgRejection = points.reduce((s, p) => s + p.rejection, 0) / points.length;
  const bestRecencyIndex = Math.max(...points.map(p => p.index));

  return {
    price: Math.round(avgPrice * 100) / 100,
    touches: points.length,
    avgVolume,
    avgRejection,
    bestRecencyIndex,
    type: points[0].type,
  };
}

/**
 * Composite strength score (1-10) from 4 factors:
 *   Touches (30%), Volume (25%), Recency (25%), Rejection (20%)
 */
export function scoreLevelStrength(input: StrengthInput): number {
  const { touches, avgVolume, avgSymbolVolume, bestRecencyDays, avgRejection } = input;

  // Touch score: 1→0.2, 2→0.47, 3→0.74, 4+→1.0
  const touchScore = Math.min(1.0, 0.2 + (touches - 1) * 0.27);

  // Volume score: ratio to symbol average, capped at 1.0
  const volScore = avgSymbolVolume > 0
    ? Math.min(1.0, (avgVolume / avgSymbolVolume) / 2.0)
    : 0.3;

  // Recency: exponential decay with 60-day half-life
  const recencyScore = Math.exp(-0.693 * bestRecencyDays / RECENCY_HALF_LIFE);

  // Rejection: 3%+ wick = max score
  const rejScore = Math.min(1.0, avgRejection / REJECTION_CALIBRATION);

  const composite = touchScore * 0.30 + volScore * 0.25 + recencyScore * 0.25 + rejScore * 0.20;
  return Math.max(1, Math.min(10, Math.round(composite * 10)));
}

/**
 * Full pipeline: detect swings → cluster → score → split into support/resistance.
 */
export function computeSupportResistance(
  bars: OHLCVBar[],
  currentPrice: number,
  opts: { window?: number; maxLevels?: number } = {},
): { support: PriceLevel[]; resistance: PriceLevel[] } {
  const { window = DEFAULT_WINDOW, maxLevels = 5 } = opts;

  const swingHighs = detectSwingPoints(bars, window).filter(p => p.type === 'high');
  const swingLows = detectSwingPoints(bars, window).filter(p => p.type === 'low');

  const totalBars = bars.length;
  const avgVolume = bars.reduce((s, b) => s + b.volume, 0) / (totalBars || 1);

  function processLevels(clusters: ClusteredLevel[]): PriceLevel[] {
    return clusters.map(c => ({
      price: c.price,
      strength: scoreLevelStrength({
        touches: c.touches,
        avgVolume: c.avgVolume,
        avgSymbolVolume: avgVolume,
        bestRecencyDays: Math.max(0, totalBars - c.bestRecencyIndex),
        avgRejection: c.avgRejection,
      }),
      type: (c.price < currentPrice ? 'support' : 'resistance') as 'support' | 'resistance',
    }));
  }

  // Cluster highs and lows separately
  const highClusters = clusterLevels(swingHighs);
  const lowClusters = clusterLevels(swingLows);

  const highLevels = processLevels(highClusters);
  const lowLevels = processLevels(lowClusters);

  const allLevels = [...highLevels, ...lowLevels];

  const support = allLevels
    .filter(l => l.price < currentPrice)
    .sort((a, b) => b.price - a.price) // nearest first
    .slice(0, maxLevels);

  const resistance = allLevels
    .filter(l => l.price > currentPrice)
    .sort((a, b) => a.price - b.price) // nearest first
    .slice(0, maxLevels);

  return { support, resistance };
}
