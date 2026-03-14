import type { Database } from './database';
import type {
  ClosedTrade,
  TradeAnalytics,
  TradeAnalyticsSummary,
  TradeBreakdown,
  SymbolPattern,
  TimingPattern,
  TradeJournalEntry,
} from '../shared/types';

export class TransactionAnalyticsService {
  constructor(private db: Database) {}

  getTradeAnalytics(days?: number): TradeAnalytics {
    let trades = this.db.getClosedTrades();
    if (days) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffStr = cutoff.toISOString().split('T')[0];
      trades = trades.filter(t => t.sellDate >= cutoffStr);
    }
    const symbolPatterns = this.getSymbolPatterns(trades);
    const timingPatterns = this.getTimingPatterns(trades, symbolPatterns);
    const holdPeriodInsight = this.getHoldPeriodInsight(trades);
    const overallInsight = this.getOverallInsight(trades, timingPatterns);

    return {
      summary: this.computeSummary(trades),
      byHoldPeriod: this.breakdownByHoldPeriod(trades),
      byRegimeAtEntry: this.breakdownByRegimeAtEntry(trades),
      byEntryStyle: this.breakdownByEntryStyle(trades),
      topWinners: [...trades].sort((a, b) => b.realizedGain - a.realizedGain).slice(0, 5),
      topLosers: [...trades].sort((a, b) => a.realizedGain - b.realizedGain).slice(0, 5),
      patterns: { symbolPatterns, timingPatterns, holdPeriodInsight, overallInsight },
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

  private getSymbolPatterns(trades: ClosedTrade[]): SymbolPattern[] {
    const bySymbol = new Map<string, ClosedTrade[]>();
    for (const t of trades) {
      if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []);
      bySymbol.get(t.symbol)!.push(t);
    }

    const patterns: SymbolPattern[] = [];
    for (const [symbol, group] of bySymbol) {
      const wins = group.filter(t => t.isWin);
      const winRate = (wins.length / group.length) * 100;
      const totalGain = group.reduce((s, t) => s + t.realizedGain, 0);
      const avgHoldDays = group.reduce((s, t) => s + t.holdDays, 0) / group.length;
      const avgGainPct = group.reduce((s, t) => s + t.realizedGainPct, 0) / group.length;

      let flag: string | undefined;
      if (group.length >= 15) {
        flag = 'overtrading';
      } else if (group.length >= 10 && winRate < 35) {
        flag = 'consistent loser';
      } else if (group.length >= 10 && winRate >= 60 && totalGain > 0) {
        flag = 'strong performer';
      }

      patterns.push({
        symbol,
        tradeCount: group.length,
        wins: wins.length,
        losses: group.length - wins.length,
        winRate: Math.round(winRate * 10) / 10,
        totalGain: Math.round(totalGain * 100) / 100,
        avgHoldDays: Math.round(avgHoldDays * 10) / 10,
        avgGainPct: Math.round(avgGainPct * 100) / 100,
        flag,
      });
    }

    return patterns.sort((a, b) => b.tradeCount - a.tradeCount);
  }

  private getTimingPatterns(trades: ClosedTrade[], symbolPatterns: SymbolPattern[]): TimingPattern[] {
    const patterns: TimingPattern[] = [];

    // 1. Rapid flips (<5 day holds)
    const rapidFlips = trades.filter(t => t.holdDays < 5);
    if (rapidFlips.length > 0) {
      const rfWins = rapidFlips.filter(t => t.isWin);
      const rfWinRate = (rfWins.length / rapidFlips.length) * 100;
      const rfPnl = rapidFlips.reduce((s, t) => s + t.realizedGain, 0);
      patterns.push({
        label: 'Rapid Flips',
        description: `${rapidFlips.length} trades held <5 days`,
        severity: rfWinRate < 40 ? 'warn' : 'info',
        detail: `Win rate: ${rfWinRate.toFixed(1)}%, P&L: $${rfPnl.toFixed(2)}`,
      });
    }

    // 2. Long holds outperformance (90d+ vs <30d)
    const longHolds = trades.filter(t => t.holdDays >= 90);
    const shortHolds = trades.filter(t => t.holdDays < 30);
    if (longHolds.length >= 5 && shortHolds.length >= 5) {
      const longWinRate = (longHolds.filter(t => t.isWin).length / longHolds.length) * 100;
      const shortWinRate = (shortHolds.filter(t => t.isWin).length / shortHolds.length) * 100;
      const diff = longWinRate - shortWinRate;
      if (Math.abs(diff) >= 10) {
        patterns.push({
          label: diff > 0 ? 'Long Holds Outperform' : 'Short Holds Outperform',
          description: `90d+ win rate ${longWinRate.toFixed(1)}% vs <30d win rate ${shortWinRate.toFixed(1)}%`,
          severity: diff > 0 ? 'strength' : 'info',
          detail: `Difference: ${Math.abs(diff).toFixed(1)} percentage points (${longHolds.length} long, ${shortHolds.length} short trades)`,
        });
      }
    }

    // 3. Monthly overtrading
    const byMonth = new Map<string, ClosedTrade[]>();
    for (const t of trades) {
      const month = t.sellDate.substring(0, 7); // YYYY-MM
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month)!.push(t);
    }
    const overtradedMonths: string[] = [];
    for (const [month, group] of byMonth) {
      if (group.length > 50) {
        const winRate = (group.filter(t => t.isWin).length / group.length) * 100;
        if (winRate < 40) {
          overtradedMonths.push(`${month} (${group.length} trades, ${winRate.toFixed(1)}% win rate)`);
        }
      }
    }
    if (overtradedMonths.length > 0) {
      patterns.push({
        label: 'Monthly Overtrading',
        description: `${overtradedMonths.length} month(s) with >50 trades and <40% win rate`,
        severity: 'warn',
        detail: overtradedMonths.join('; '),
      });
    }

    // 4. Symbol churn
    const churnSymbols = symbolPatterns.filter(sp => sp.flag === 'overtrading');
    if (churnSymbols.length > 0) {
      patterns.push({
        label: 'Symbol Churn',
        description: `${churnSymbols.length} symbol(s) with 15+ trades`,
        severity: 'warn',
        detail: churnSymbols.map(s => `${s.symbol} (${s.tradeCount} trades, ${s.winRate}% win rate)`).join('; '),
      });
    }

    return patterns;
  }

  private getHoldPeriodInsight(trades: ClosedTrade[]): string {
    if (trades.length === 0) return 'No trades to analyze.';
    const avgHold = trades.reduce((s, t) => s + t.holdDays, 0) / trades.length;
    const longPct = (trades.filter(t => t.holdDays >= 90).length / trades.length) * 100;
    const shortPct = (trades.filter(t => t.holdDays < 30).length / trades.length) * 100;
    return `Average hold: ${Math.round(avgHold)}d. ${longPct.toFixed(1)}% held 90d+, ${shortPct.toFixed(1)}% held <30d.`;
  }

  getTradeJournal(opts?: { symbol?: string; days?: number }): TradeJournalEntry[] {
    const db = this.db.getRawDb();
    let cutoff = '2000-01-01';
    if (opts?.days) {
      const d = new Date();
      d.setDate(d.getDate() - opts.days);
      cutoff = d.toISOString().split('T')[0];
    }

    const symbolFilter = opts?.symbol ? "AND UPPER(s.symbol) = UPPER(?)" : "";
    const params: any[] = [cutoff];
    if (opts?.symbol) params.push(opts.symbol);

    const rows = db.prepare(`
      SELECT
        s.symbol,
        t.date as sell_date,
        t.quantity as sell_qty,
        t.price as sell_price,
        (SELECT tb.date FROM transactions tb
         WHERE tb.security_id = t.security_id AND tb.account_id = t.account_id
         AND tb.type = 'buy' AND tb.date <= t.date
         ORDER BY tb.date DESC LIMIT 1) as buy_date,
        (SELECT tb.price FROM transactions tb
         WHERE tb.security_id = t.security_id AND tb.account_id = t.account_id
         AND tb.type = 'buy' AND tb.date <= t.date
         ORDER BY tb.date DESC LIMIT 1) as buy_price,
        (SELECT dr.regime_type FROM daily_rituals dr WHERE dr.date = t.date) as regime_at_exit,
        (SELECT dr.action_chosen FROM daily_rituals dr WHERE dr.date = t.date) as action_chosen,
        (SELECT dr.journal FROM daily_rituals dr WHERE dr.date = t.date) as journal,
        (SELECT dl.decision FROM decision_logs dl
         WHERE dl.security_id = t.security_id
         AND dl.decision_date BETWEEN date(t.date, '-3 days') AND t.date
         ORDER BY dl.decision_date DESC LIMIT 1) as decision_note,
        a.account_number
      FROM transactions t
      JOIN securities s ON t.security_id = s.id
      JOIN accounts a ON t.account_id = a.id
      WHERE t.type = 'sell'
        AND t.date >= ?
        ${symbolFilter}
      ORDER BY t.date DESC
      LIMIT 200
    `).all(...params) as any[];

    return rows.map(r => ({
      symbol: r.symbol,
      sellDate: r.sell_date,
      sellPrice: r.sell_price,
      sellQty: r.sell_qty,
      buyDate: r.buy_date,
      buyPrice: r.buy_price,
      holdDays: r.buy_date && r.sell_date
        ? Math.round((new Date(r.sell_date).getTime() - new Date(r.buy_date).getTime()) / 86400000)
        : null,
      realizedGain: r.buy_price ? (r.sell_price - r.buy_price) * r.sell_qty : null,
      realizedGainPct: r.buy_price && r.buy_price > 0 ? ((r.sell_price / r.buy_price) - 1) * 100 : null,
      regimeAtExit: r.regime_at_exit,
      actionChosen: r.action_chosen,
      journal: r.journal,
      decisionNote: r.decision_note,
      accountNumber: r.account_number,
    }));
  }

  private getOverallInsight(trades: ClosedTrade[], timingPatterns: TimingPattern[]): string {
    if (trades.length === 0) return 'No trades to analyze.';
    const warnings = timingPatterns.filter(p => p.severity === 'warn').length;
    const strengths = timingPatterns.filter(p => p.severity === 'strength').length;
    if (warnings === 0 && strengths === 0) {
      return `${trades.length} trades analyzed. No significant patterns detected.`;
    }
    if (warnings > strengths) {
      return `${trades.length} trades analyzed. ${warnings} warning(s) detected — review timing and symbol concentration.`;
    }
    if (strengths > warnings) {
      return `${trades.length} trades analyzed. ${strengths} strength(s) identified with ${warnings} area(s) to watch.`;
    }
    return `${trades.length} trades analyzed. ${strengths} strength(s) and ${warnings} warning(s) — mixed signals.`;
  }
}
