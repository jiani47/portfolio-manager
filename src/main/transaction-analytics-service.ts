import type { Database } from './database';
import type {
  ClosedTrade,
  TradeAnalytics,
  TradeAnalyticsSummary,
  TradeBreakdown,
} from '../shared/types';

export class TransactionAnalyticsService {
  constructor(private db: Database) {}

  getTradeAnalytics(): TradeAnalytics {
    const trades = this.db.getClosedTrades();
    return {
      summary: this.computeSummary(trades),
      byHoldPeriod: this.breakdownByHoldPeriod(trades),
      byRegimeAtEntry: this.breakdownByRegimeAtEntry(trades),
      byEntryStyle: this.breakdownByEntryStyle(trades),
      topWinners: [...trades].sort((a, b) => b.realizedGain - a.realizedGain).slice(0, 5),
      topLosers: [...trades].sort((a, b) => a.realizedGain - b.realizedGain).slice(0, 5),
    };
  }

  private computeSummary(trades: ClosedTrade[]): TradeAnalyticsSummary {
    if (trades.length === 0) {
      return {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        totalRealizedGain: 0,
        avgWin: 0,
        avgLoss: 0,
        largestWin: 0,
        largestLoss: 0,
        profitFactor: 0,
      };
    }
    const wins = trades.filter(t => t.isWin);
    const losses = trades.filter(t => !t.isWin);
    const grossWins = wins.reduce((s, t) => s + t.realizedGain, 0);
    const grossLosses = Math.abs(losses.reduce((s, t) => s + t.realizedGain, 0));
    return {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: (wins.length / trades.length) * 100,
      totalRealizedGain: trades.reduce((s, t) => s + t.realizedGain, 0),
      avgWin: wins.length > 0 ? grossWins / wins.length : 0,
      avgLoss: losses.length > 0 ? -grossLosses / losses.length : 0,
      largestWin: wins.length > 0 ? Math.max(...wins.map(t => t.realizedGain)) : 0,
      largestLoss: losses.length > 0 ? Math.min(...losses.map(t => t.realizedGain)) : 0,
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0,
    };
  }

  private buildBreakdown(label: string, trades: ClosedTrade[]): TradeBreakdown {
    const wins = trades.filter(t => t.isWin);
    return {
      label,
      count: trades.length,
      wins: wins.length,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      avgGain:
        trades.length > 0
          ? trades.reduce((s, t) => s + t.realizedGain, 0) / trades.length
          : 0,
      totalGain: trades.reduce((s, t) => s + t.realizedGain, 0),
    };
  }

  private breakdownByHoldPeriod(trades: ClosedTrade[]): TradeBreakdown[] {
    const buckets: Record<string, ClosedTrade[]> = {
      'Short (<30d)': [],
      'Medium (30-90d)': [],
      'Long (90d+)': [],
    };
    for (const t of trades) {
      if (t.holdBucket === 'short') buckets['Short (<30d)'].push(t);
      else if (t.holdBucket === 'medium') buckets['Medium (30-90d)'].push(t);
      else buckets['Long (90d+)'].push(t);
    }
    return Object.entries(buckets).map(([label, group]) =>
      this.buildBreakdown(label, group)
    );
  }

  private breakdownByRegimeAtEntry(trades: ClosedTrade[]): TradeBreakdown[] {
    const regimeMap = this.getRegimeMap();
    const buckets: Record<string, ClosedTrade[]> = {};
    for (const t of trades) {
      const regime = regimeMap.get(t.buyDate) || 'Unknown';
      if (!buckets[regime]) buckets[regime] = [];
      buckets[regime].push(t);
    }
    return Object.entries(buckets)
      .map(([label, group]) => this.buildBreakdown(label, group))
      .sort((a, b) => b.count - a.count);
  }

  private breakdownByEntryStyle(trades: ClosedTrade[]): TradeBreakdown[] {
    const styleMap = this.getEntryStyleMap();
    const buckets: Record<string, ClosedTrade[]> = {};
    for (const t of trades) {
      const style = styleMap.get(t.securityId) || 'Unknown';
      if (!buckets[style]) buckets[style] = [];
      buckets[style].push(t);
    }
    return Object.entries(buckets)
      .map(([label, group]) => this.buildBreakdown(label, group))
      .sort((a, b) => b.count - a.count);
  }

  private getRegimeMap(): Map<string, string> {
    const rows = this.db
      .getRawDb()
      .prepare(
        `SELECT date, regime_type FROM daily_rituals WHERE regime_type IS NOT NULL`
      )
      .all() as Array<{ date: string; regime_type: string }>;
    const map = new Map<string, string>();
    for (const row of rows) map.set(row.date, row.regime_type);
    return map;
  }

  private getEntryStyleMap(): Map<string, string> {
    const rows = this.db
      .getRawDb()
      .prepare(
        `
      SELECT p.security_id, pi.entry_style
      FROM position_intents pi
      JOIN positions p ON pi.position_id = p.id
      WHERE pi.entry_style IS NOT NULL
    `
      )
      .all() as Array<{ security_id: string; entry_style: string }>;
    const map = new Map<string, string>();
    for (const row of rows) map.set(row.security_id, row.entry_style);
    return map;
  }
}
