import { Database } from './database';
import { PortfolioAnalytics, PositionBeta } from '../shared/types';

export class AnalyticsService {
  constructor(private db: Database) {}

  getPortfolioAnalytics(days: number = 90): PortfolioAnalytics {
    const snapshots = this.db.getSnapshotDailyTotals(days + 1); // +1 for return calc
    const spyPrices = this.db.getPriceHistoryBySymbol('SPY', days + 1);

    if (snapshots.length < 2) {
      return this.emptyAnalytics(days);
    }

    // Portfolio daily returns
    const portfolioReturns = this.computeDailyReturns(
      snapshots.map(s => ({ date: s.date, value: s.totalMv }))
    );

    // Benchmark daily returns
    const benchmarkReturns = this.computeDailyReturns(
      spyPrices.map(p => ({ date: p.date, value: p.closePrice }))
    );

    // Align dates
    const { aligned: alignedPortfolio, alignedBenchmark } = this.alignReturns(portfolioReturns, benchmarkReturns);

    // Portfolio metrics
    const totalReturn = snapshots.length >= 2
      ? (snapshots[snapshots.length - 1].totalMv - snapshots[0].totalMv) / snapshots[0].totalMv
      : 0;

    const annualizedReturn = this.annualizeReturn(totalReturn, snapshots.length);
    const volatility = this.computeVolatility(alignedPortfolio.map(r => r.ret));
    const riskFreeRate = 0.05;
    const sharpeRatio = volatility > 0 ? (annualizedReturn - riskFreeRate) / volatility : 0;

    // Beta
    const beta = this.computeBeta(
      alignedPortfolio.map(r => r.ret),
      alignedBenchmark.map(r => r.ret)
    );

    // Weighted beta from positions
    const positionBetas = this.getPositionBetas(days);
    const weightedBeta = positionBetas.reduce((sum, p) => sum + p.weightedBeta, 0);

    // Drawdown
    const mvSeries = snapshots.map(s => ({ date: s.date, value: s.totalMv }));
    const { maxDrawdown, maxDrawdownDate } = this.computeMaxDrawdown(mvSeries);
    const currentDrawdown = this.computeCurrentDrawdown(mvSeries);

    // Benchmark return
    const benchmarkTotalReturn = spyPrices.length >= 2
      ? (spyPrices[spyPrices.length - 1].closePrice - spyPrices[0].closePrice) / spyPrices[0].closePrice
      : 0;

    return {
      beta,
      weightedBeta,
      volatility,
      sharpeRatio,
      maxDrawdown,
      maxDrawdownDate,
      currentDrawdown,
      annualizedReturn,
      totalReturn,
      benchmarkReturn: benchmarkTotalReturn,
      dataPoints: alignedPortfolio.length,
      periodDays: days,
    };
  }

  getPositionBetas(days: number = 90): PositionBeta[] {
    const positionWeights = this.db.getPositionWeights();
    const spyPrices = this.db.getPriceHistoryBySymbol('SPY', days + 1);
    const benchmarkReturns = this.computeDailyReturns(
      spyPrices.map(p => ({ date: p.date, value: p.closePrice }))
    );

    if (benchmarkReturns.length < 10) return [];

    const results: PositionBeta[] = [];

    for (const pos of positionWeights) {
      const prices = this.db.getPriceHistoryBySymbol(pos.symbol, days + 1);
      if (prices.length < 10) continue;

      const posReturns = this.computeDailyReturns(
        prices.map(p => ({ date: p.date, value: p.closePrice }))
      );

      const { aligned, alignedBenchmark } = this.alignReturns(posReturns, benchmarkReturns);
      if (aligned.length < 10) continue;

      const posRets = aligned.map(r => r.ret);
      const bmkRets = alignedBenchmark.map(r => r.ret);

      const beta = this.computeBeta(posRets, bmkRets);
      const correlation = this.computeCorrelation(posRets, bmkRets);

      results.push({
        symbol: pos.symbol,
        beta,
        correlation,
        weight: pos.weight,
        weightedBeta: beta * pos.weight,
      });
    }

    return results.sort((a, b) => b.weight - a.weight);
  }

  // --- Internal computation methods ---

  private computeDailyReturns(series: Array<{ date: string; value: number }>): Array<{ date: string; ret: number }> {
    const returns: Array<{ date: string; ret: number }> = [];
    for (let i = 1; i < series.length; i++) {
      if (series[i - 1].value > 0) {
        returns.push({
          date: series[i].date,
          ret: (series[i].value - series[i - 1].value) / series[i - 1].value,
        });
      }
    }
    return returns;
  }

  private alignReturns(
    portfolio: Array<{ date: string; ret: number }>,
    benchmark: Array<{ date: string; ret: number }>
  ): { aligned: Array<{ date: string; ret: number }>; alignedBenchmark: Array<{ date: string; ret: number }> } {
    const bmkMap = new Map(benchmark.map(r => [r.date, r]));
    const aligned: Array<{ date: string; ret: number }> = [];
    const alignedBenchmark: Array<{ date: string; ret: number }> = [];

    for (const pr of portfolio) {
      const br = bmkMap.get(pr.date);
      if (br) {
        aligned.push(pr);
        alignedBenchmark.push(br);
      }
    }

    return { aligned, alignedBenchmark };
  }

  private computeBeta(portfolioReturns: number[], benchmarkReturns: number[]): number {
    if (portfolioReturns.length < 2) return 1;

    const n = portfolioReturns.length;
    const meanP = portfolioReturns.reduce((s, v) => s + v, 0) / n;
    const meanB = benchmarkReturns.reduce((s, v) => s + v, 0) / n;

    let cov = 0;
    let varB = 0;
    for (let i = 0; i < n; i++) {
      const dp = portfolioReturns[i] - meanP;
      const db = benchmarkReturns[i] - meanB;
      cov += dp * db;
      varB += db * db;
    }

    return varB > 0 ? cov / varB : 1;
  }

  private computeCorrelation(a: number[], b: number[]): number {
    if (a.length < 2) return 0;

    const n = a.length;
    const meanA = a.reduce((s, v) => s + v, 0) / n;
    const meanB = b.reduce((s, v) => s + v, 0) / n;

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

  private computeVolatility(dailyReturns: number[]): number {
    if (dailyReturns.length < 2) return 0;

    const n = dailyReturns.length;
    const mean = dailyReturns.reduce((s, v) => s + v, 0) / n;
    const variance = dailyReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);

    // Annualize: daily stddev * sqrt(252)
    return Math.sqrt(variance) * Math.sqrt(252);
  }

  private annualizeReturn(totalReturn: number, tradingDays: number): number {
    if (tradingDays <= 1) return 0;
    // (1 + total)^(252/days) - 1
    return Math.pow(1 + totalReturn, 252 / tradingDays) - 1;
  }

  private computeMaxDrawdown(series: Array<{ date: string; value: number }>): { maxDrawdown: number; maxDrawdownDate: string } {
    let peak = -Infinity;
    let maxDrawdown = 0;
    let maxDrawdownDate = '';

    for (const point of series) {
      if (point.value > peak) peak = point.value;
      const drawdown = (peak - point.value) / peak;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        maxDrawdownDate = point.date;
      }
    }

    return { maxDrawdown, maxDrawdownDate };
  }

  private computeCurrentDrawdown(series: Array<{ date: string; value: number }>): number {
    if (series.length === 0) return 0;

    let peak = -Infinity;
    for (const point of series) {
      if (point.value > peak) peak = point.value;
    }

    const current = series[series.length - 1].value;
    return peak > 0 ? (peak - current) / peak : 0;
  }

  private emptyAnalytics(days: number): PortfolioAnalytics {
    return {
      beta: 0,
      weightedBeta: 0,
      volatility: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      maxDrawdownDate: '',
      currentDrawdown: 0,
      annualizedReturn: 0,
      totalReturn: 0,
      benchmarkReturn: 0,
      dataPoints: 0,
      periodDays: days,
    };
  }
}
