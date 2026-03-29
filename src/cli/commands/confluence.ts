/**
 * CLI confluence command — detect entry signal alignment across symbols.
 */
import type Database from 'better-sqlite3';
import { PricingRepository } from '../../shared/repositories/pricing-repository';
import { ValuationRepository } from '../../shared/repositories/valuation-repository';
import {
  detectConfluenceSignals,
  type ConfluenceResult,
} from '../../shared/analytics/confluence';
import type { PegRating } from '../../shared/analytics/valuation';

export function run(_args: string[], db: Database.Database): ConfluenceResult[] {
  const valRepo = new ValuationRepository(db);
  const priceRepo = new PricingRepository(db);

  const allVals = valRepo.getAll();
  const results: ConfluenceResult[] = [];

  for (const v of allVals) {
    const currentPrice = priceRepo.getLatestPrice(v.symbol);
    if (!currentPrice) continue;

    const supports = priceRepo.getSupportLevels(v.symbol);

    const result = detectConfluenceSignals({
      symbol: v.symbol,
      currentPrice,
      forwardPeg: v.forwardPeg,
      pegRating: v.pegRating as PegRating | null,
      epsGrowthPct: v.epsGrowthPct,
      nearestSupport: supports[0] ?? null,
      nearestResistance: null,
    });

    if (result.hasConfluence) {
      results.push(result);
    }
  }

  return results.sort((a, b) => b.signalCount - a.signalCount);
}
