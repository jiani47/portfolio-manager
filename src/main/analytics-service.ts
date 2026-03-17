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

    const volatility = this.computeVolatility(alignedPortfolio.map(r => r.ret));
    const riskFreeRate = 0.05;
    // Only annualize when we have enough data (30+ trading days); otherwise raw return
    const annualizedReturn = snapshots.length >= 30
      ? this.annualizeReturn(totalReturn, snapshots.length)
      : totalReturn;
    // Sharpe is meaningless with < 30 data points
    const sharpeRatio = (volatility > 0 && alignedPortfolio.length >= 30)
      ? (annualizedReturn - riskFreeRate) / volatility
      : 0;

    // Beta
    const beta = this.computeBeta(
      alignedPortfolio.map(r => r.ret),
      alignedBenchmark.map(r => r.ret)
    );

    // Weighted beta from positions (equity-only weights, sum to 1.0)
    const positionBetas = this.getPositionBetas(days);
    const weightedBeta = positionBetas.reduce((sum, p) => sum + p.weightedBeta, 0);

    // Weighted beta including cash (dilutes beta by cash proportion)
    const positionWeights = this.db.getPositionWeights();
    const equityMV = positionWeights.reduce((sum, p) => sum + p.marketValue, 0);
    const cashPositions = this.db.listPositions();
    const cashSecurities = this.db.listSecurities().filter(s => s.type === 'cash');
    const cashIds = new Set(cashSecurities.map(s => s.id));
    const cashMV = cashPositions.filter(p => cashIds.has(p.securityId)).reduce((sum, p) => sum + (p.quantity || 0), 0);
    const totalMV = equityMV + cashMV;
    const equityFraction = totalMV > 0 ? equityMV / totalMV : 1;
    const weightedBetaWithCash = weightedBeta * equityFraction;

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
      weightedBetaWithCash,
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

  // --- Correlation & Concentration Analysis (Phase 10.1) ---

  getCorrelationMatrix(days: number = 90): {
    symbols: string[];
    matrix: number[][];
    highCorrelations: Array<{ symbolA: string; symbolB: string; correlation: number }>;
  } {
    const positionWeights = this.db.getPositionWeights();
    if (positionWeights.length < 2) return { symbols: [], matrix: [], highCorrelations: [] };

    // Get returns for each symbol
    const symbolReturns = new Map<string, Array<{ date: string; ret: number }>>();
    const symbols: string[] = [];

    for (const pos of positionWeights) {
      const prices = this.db.getPriceHistoryBySymbol(pos.symbol, days + 1);
      if (prices.length < 10) continue;
      const returns = this.computeDailyReturns(
        prices.map(p => ({ date: p.date, value: p.closePrice }))
      );
      if (returns.length < 10) continue;
      symbolReturns.set(pos.symbol, returns);
      symbols.push(pos.symbol);
    }

    const n = symbols.length;
    const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
    const highCorrelations: Array<{ symbolA: string; symbolB: string; correlation: number }> = [];

    for (let i = 0; i < n; i++) {
      matrix[i][i] = 1.0;
      for (let j = i + 1; j < n; j++) {
        const retA = symbolReturns.get(symbols[i])!;
        const retB = symbolReturns.get(symbols[j])!;
        const { aligned, alignedBenchmark } = this.alignReturns(retA, retB);
        if (aligned.length < 10) continue;
        const corr = this.computeCorrelation(
          aligned.map(r => r.ret),
          alignedBenchmark.map(r => r.ret)
        );
        matrix[i][j] = corr;
        matrix[j][i] = corr;
        if (Math.abs(corr) >= 0.7) {
          highCorrelations.push({ symbolA: symbols[i], symbolB: symbols[j], correlation: corr });
        }
      }
    }

    highCorrelations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
    return { symbols, matrix, highCorrelations };
  }

  getConcentrationAnalysis(): {
    sectorConcentration: Array<{ sector: string; weight: number; symbols: string[] }>;
    tierConcentration: Array<{ tier: string; weight: number; count: number }>;
    top5Weight: number;
    herfindahlIndex: number;
    effectivePositions: number;
  } {
    const positionWeights = this.db.getPositionWeights();
    const securities = this.db.listSecurities();
    const intents = this.db.listPositionIntents();

    const secMap = new Map(securities.map(s => [s.symbol, s]));
    const intentMap = new Map(intents.map(i => [i.positionId, i]));

    // Get position IDs for intent lookup
    const positions = this.db.listPositionsWithMTM();
    const posSymbolToIntent = new Map<string, string>();
    for (const p of positions) {
      const sec = securities.find(s => s.id === p.securityId);
      if (sec) {
        const intent = intentMap.get(p.id);
        if (intent?.tier) posSymbolToIntent.set(sec.symbol, intent.tier);
      }
    }

    // Sector concentration
    const sectorMap = new Map<string, { weight: number; symbols: string[] }>();
    for (const pw of positionWeights) {
      const sec = secMap.get(pw.symbol);
      const sector = sec?.sector || 'Unknown';
      const existing = sectorMap.get(sector) || { weight: 0, symbols: [] };
      existing.weight += pw.weight;
      existing.symbols.push(pw.symbol);
      sectorMap.set(sector, existing);
    }
    const sectorConcentration = Array.from(sectorMap.entries())
      .map(([sector, data]) => ({ sector, weight: data.weight * 100, symbols: data.symbols }))
      .sort((a, b) => b.weight - a.weight);

    // Tier concentration
    const tierMap = new Map<string, { weight: number; count: number }>();
    for (const pw of positionWeights) {
      const tier = posSymbolToIntent.get(pw.symbol) || 'Untagged';
      const existing = tierMap.get(tier) || { weight: 0, count: 0 };
      existing.weight += pw.weight;
      existing.count++;
      tierMap.set(tier, existing);
    }
    const tierConcentration = Array.from(tierMap.entries())
      .map(([tier, data]) => ({ tier, weight: data.weight * 100, count: data.count }))
      .sort((a, b) => b.weight - a.weight);

    // Top 5 weight
    const sortedWeights = positionWeights.map(p => p.weight).sort((a, b) => b - a);
    const top5Weight = sortedWeights.slice(0, 5).reduce((s, w) => s + w, 0) * 100;

    // Herfindahl Index (sum of squared weights) — lower = more diversified
    const hhi = positionWeights.reduce((s, p) => s + (p.weight * 100) ** 2, 0);

    // Effective number of positions (1/HHI normalized)
    const effectivePositions = hhi > 0 ? 10000 / hhi : 0;

    return { sectorConcentration, tierConcentration, top5Weight, herfindahlIndex: hhi, effectivePositions };
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
      weightedBetaWithCash: 0,
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
