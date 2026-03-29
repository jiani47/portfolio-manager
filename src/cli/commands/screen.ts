/**
 * CLI screen command — composite valuation/technical/growth ranking.
 */
import type Database from 'better-sqlite3';
import { PricingRepository } from '../../shared/repositories/pricing-repository';
import { ValuationRepository } from '../../shared/repositories/valuation-repository';
import {
  calculateScreeningScore,
  type ScreeningResult,
} from '../../shared/analytics/confluence';
import type { PegRating } from '../../shared/analytics/valuation';

export function run(_args: string[], db: Database.Database): ScreeningResult[] {
  const valRepo = new ValuationRepository(db);
  const priceRepo = new PricingRepository(db);

  const allVals = valRepo.getAll();
  const results: ScreeningResult[] = [];

  for (const v of allVals) {
    const currentPrice = priceRepo.getLatestPrice(v.symbol);
    if (!currentPrice) continue;

    const supports = priceRepo.getSupportLevels(v.symbol);
    const resistances = priceRepo.getResistanceLevels(v.symbol);

    results.push(calculateScreeningScore({
      symbol: v.symbol,
      currentPrice,
      pegRating: v.pegRating as PegRating | null,
      epsGrowthPct: v.epsGrowthPct,
      nearestSupport: supports[0] ?? null,
      nearestResistance: resistances[0] ?? null,
    }));
  }

  return results.sort((a, b) => b.compositeScore - a.compositeScore);
}
