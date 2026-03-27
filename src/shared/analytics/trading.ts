/**
 * Trade statistics — win rate, R/R, profit factor, open P&L.
 * Pure functions operating on pre-computed trade data.
 */

export interface ClosedTradeInput {
  realizedGain: number;
  realizedGainPct: number;
  holdDays: number;
  isWin: boolean;
}

export interface TradeStatsResult {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalRealizedGain: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  profitFactor: number;
  avgRiskReward: number;
}

export function calculateTradeStats(trades: ClosedTradeInput[]): TradeStatsResult {
  if (trades.length === 0) {
    return {
      totalTrades: 0, wins: 0, losses: 0, winRate: 0,
      totalRealizedGain: 0, avgWin: 0, avgLoss: 0,
      largestWin: 0, largestLoss: 0, profitFactor: 0, avgRiskReward: 0,
    };
  }

  const winTrades = trades.filter(t => t.isWin);
  const lossTrades = trades.filter(t => !t.isWin);

  const grossWins = winTrades.reduce((s, t) => s + t.realizedGain, 0);
  const grossLosses = Math.abs(lossTrades.reduce((s, t) => s + t.realizedGain, 0));

  const avgWin = winTrades.length > 0 ? grossWins / winTrades.length : 0;
  const avgLoss = lossTrades.length > 0 ? -(grossLosses / lossTrades.length) : 0;

  let profitFactor: number;
  if (grossLosses > 0) {
    profitFactor = grossWins / grossLosses;
  } else {
    profitFactor = grossWins > 0 ? Infinity : 0;
  }

  const avgRiskReward = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

  return {
    totalTrades: trades.length,
    wins: winTrades.length,
    losses: lossTrades.length,
    winRate: (winTrades.length / trades.length) * 100,
    totalRealizedGain: trades.reduce((s, t) => s + t.realizedGain, 0),
    avgWin,
    avgLoss,
    largestWin: winTrades.length > 0 ? Math.max(...winTrades.map(t => t.realizedGain)) : 0,
    largestLoss: lossTrades.length > 0 ? Math.min(...lossTrades.map(t => t.realizedGain)) : 0,
    profitFactor,
    avgRiskReward,
  };
}

// --- Open P&L ---

export interface OpenTradeInput {
  shares: number;
  entryPrice: number;
  currentPrice: number | null;
}

export interface OpenPnlResult {
  unrealizedGain: number;
  unrealizedGainPct: number;
}

export function calculateOpenPnl(trades: OpenTradeInput[]): OpenPnlResult[] {
  return trades.map(t => {
    const price = t.currentPrice ?? t.entryPrice;
    const unrealizedGain = t.shares * (price - t.entryPrice);
    const unrealizedGainPct = t.entryPrice > 0
      ? ((price - t.entryPrice) / t.entryPrice) * 100
      : 0;
    return { unrealizedGain, unrealizedGainPct };
  });
}
