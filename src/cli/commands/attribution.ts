/**
 * CLI attribution command — factor decomposition vs QQQ benchmark.
 */
import type Database from 'better-sqlite3';
import { PositionRepository } from '../../shared/repositories/position-repository';
import { PricingRepository } from '../../shared/repositories/pricing-repository';
import {
  computeBeta,
  decomposeAttribution,
  calculatePositionContribution,
  type DailyReturn,
  type AttributionResult,
  type PositionContribution,
  type SectorWeight,
} from '../../shared/analytics/attribution';

// QQQ approximate sector weights
const QQQ_SECTORS: Record<string, number> = {
  'Technology': 0.50,
  'Communication Services': 0.16,
  'Consumer Cyclical': 0.14,
  'Healthcare': 0.05,
  'Consumer Defensive': 0.04,
  'Industrials': 0.04,
  'Financial Services': 0.01,
};

export interface AttributionCommandResult {
  days: number;
  portfolioReturn: number;
  benchmarkReturn: number;
  portfolioBeta: number;
  decomposition: AttributionResult;
  positionContributions: PositionContribution[];
}

export function run(args: string[], db: Database.Database): AttributionCommandResult {
  let days: number;
  if (args[0]?.toUpperCase() === 'YTD') {
    const latest = db.prepare('SELECT MAX(date) as d FROM price_history').get() as { d: string } | undefined;
    if (!latest?.d) return emptyResult(0);
    const latestDate = new Date(latest.d);
    const jan1 = new Date(latestDate.getFullYear(), 0, 1);
    days = Math.floor((latestDate.getTime() - jan1.getTime()) / (1000 * 60 * 60 * 24));
    if (days < 2) return emptyResult(days);
  } else {
    days = args[0] ? parseInt(args[0], 10) : 90;
    if (isNaN(days)) days = 90;
  }

  const posRepo = new PositionRepository(db);
  const priceRepo = new PricingRepository(db);

  // Get positions with weights
  const allPositions = posRepo.getAllForAllocation();
  const equityPositions = allPositions.filter(
    p => p.securityType !== 'cash' && p.securityType !== 'option',
  );

  const totalEquityMV = equityPositions.reduce((s, p) => s + p.quantity * p.price, 0);
  if (totalEquityMV <= 0) {
    return emptyResult(days);
  }

  // Build daily return series for portfolio and QQQ
  const qqqPrices = priceRepo.getClosePrices('QQQ', days);
  if (qqqPrices.length < 2) {
    return emptyResult(days);
  }

  // Build a date→return map for each position
  const positionData = equityPositions.map(p => {
    const prices = priceRepo.getClosePrices(p.symbol, days);
    const weight = (p.quantity * p.price) / totalEquityMV;
    return { symbol: p.symbol, weight, prices, sector: getSector(db, p.symbol) };
  });

  // Compute portfolio daily returns (weighted sum)
  const dateSet = new Set(qqqPrices.map(p => p.date));
  const dailyReturns: DailyReturn[] = [];

  const qqqReturnMap = buildReturnMap(qqqPrices);

  for (const date of dateSet) {
    const benchRet = qqqReturnMap.get(date);
    if (benchRet == null) continue;

    let portRet = 0;
    let validWeight = 0;
    for (const pos of positionData) {
      const retMap = buildReturnMap(pos.prices);
      const ret = retMap.get(date);
      if (ret != null) {
        portRet += pos.weight * ret;
        validWeight += pos.weight;
      }
    }

    if (validWeight > 0) {
      dailyReturns.push({
        date,
        portfolioReturn: portRet / validWeight * 1, // normalize if partial
        benchmarkReturn: benchRet,
      });
    }
  }

  // Period returns
  const qqqStart = qqqPrices[0].close;
  const qqqEnd = qqqPrices[qqqPrices.length - 1].close;
  const benchmarkReturn = qqqStart > 0 ? (qqqEnd - qqqStart) / qqqStart : 0;

  let portfolioReturn = 0;
  for (const pos of positionData) {
    if (pos.prices.length >= 2) {
      const start = pos.prices[0].close;
      const end = pos.prices[pos.prices.length - 1].close;
      const ret = start > 0 ? (end - start) / start : 0;
      portfolioReturn += pos.weight * ret;
    }
  }

  const portfolioBeta = computeBeta(dailyReturns);

  // Sector weights for Brinson decomposition
  const sectorMap = new Map<string, { portWeight: number; returns: number[] }>();
  for (const pos of positionData) {
    const sector = pos.sector || 'Other';
    const existing = sectorMap.get(sector) || { portWeight: 0, returns: [] };
    existing.portWeight += pos.weight;
    if (pos.prices.length >= 2) {
      const start = pos.prices[0].close;
      const end = pos.prices[pos.prices.length - 1].close;
      existing.returns.push(start > 0 ? (end - start) / start : 0);
    }
    sectorMap.set(sector, existing);
  }

  const sectorWeights: SectorWeight[] = [];
  for (const [sector, data] of sectorMap) {
    const avgReturn = data.returns.length > 0
      ? data.returns.reduce((s, r) => s + r, 0) / data.returns.length
      : 0;
    sectorWeights.push({
      sector,
      portfolioWeight: data.portWeight,
      benchmarkWeight: QQQ_SECTORS[sector] || 0,
      sectorReturn: avgReturn,
    });
  }

  const decomposition = decomposeAttribution({
    portfolioReturn,
    benchmarkReturn,
    portfolioBeta,
    sectorWeights,
  });

  const positionContributions = calculatePositionContribution(
    positionData.map(p => {
      const start = p.prices[0]?.close;
      const end = p.prices[p.prices.length - 1]?.close;
      return {
        symbol: p.symbol,
        weight: p.weight,
        positionReturn: start && end ? (end - start) / start : 0,
      };
    }),
    benchmarkReturn,
  );

  return { days, portfolioReturn, benchmarkReturn, portfolioBeta, decomposition, positionContributions };
}

function buildReturnMap(prices: { date: string; close: number }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1].close > 0) {
      map.set(prices[i].date, (prices[i].close - prices[i - 1].close) / prices[i - 1].close);
    }
  }
  return map;
}

function getSector(db: Database.Database, symbol: string): string {
  const row = db.prepare('SELECT sector FROM securities WHERE symbol = ?').get(symbol) as { sector: string | null } | undefined;
  return row?.sector || 'Other';
}

function emptyResult(days: number): AttributionCommandResult {
  return {
    days,
    portfolioReturn: 0,
    benchmarkReturn: 0,
    portfolioBeta: 1,
    decomposition: { gap: 0, betaEffect: 0, sectorAllocation: 0, stockSelection: 0 },
    positionContributions: [],
  };
}
