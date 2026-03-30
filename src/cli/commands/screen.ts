/**
 * CLI screen command — composite valuation/technical/growth ranking.
 */
import type Database from 'better-sqlite3';
import { PricingRepository } from '../../shared/repositories/pricing-repository';
import { ValuationRepository } from '../../shared/repositories/valuation-repository';
import {
  calculateScreeningScore,
} from '../../shared/analytics/confluence';
import type { PegRating } from '../../shared/analytics/valuation';

export interface ScreenCommandResult {
  symbol: string;
  price: number;
  pegRating: string | null;
  forwardPeg: number | null;
  forwardPe: number | null;
  epsGrowthPct: number | null;
  valuationScore: number;
  technicalScore: number;
  growthScore: number;
  compositeScore: number;
  watchlist: string | null;
}

export function run(_args: string[], db: Database.Database): ScreenCommandResult[] {
  const valRepo = new ValuationRepository(db);
  const priceRepo = new PricingRepository(db);

  const watchlistRows = db.prepare(`
    SELECT wi.symbol, w.name as watchlist
    FROM watchlist_items wi
    JOIN watchlists w ON wi.watchlist_id = w.id
  `).all() as { symbol: string; watchlist: string }[];
  const watchlistMap = new Map(watchlistRows.map(r => [r.symbol, r.watchlist]));

  const allVals = valRepo.getAll();
  const results: ScreenCommandResult[] = [];

  for (const v of allVals) {
    const currentPrice = priceRepo.getLatestPrice(v.symbol);
    if (!currentPrice) continue;

    const supports = priceRepo.getSupportLevels(v.symbol);
    const resistances = priceRepo.getResistanceLevels(v.symbol);

    const score = calculateScreeningScore({
      symbol: v.symbol,
      currentPrice,
      pegRating: v.pegRating as PegRating | null,
      epsGrowthPct: v.epsGrowthPct,
      nearestSupport: supports[0] ?? null,
      nearestResistance: resistances[0] ?? null,
    });

    results.push({
      ...score,
      price: currentPrice,
      pegRating: v.pegRating,
      forwardPeg: v.forwardPeg,
      forwardPe: v.forwardPe,
      epsGrowthPct: v.epsGrowthPct,
      watchlist: watchlistMap.get(v.symbol) || null,
    });
  }

  return results.sort((a, b) => b.compositeScore - a.compositeScore);
}
