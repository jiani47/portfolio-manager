/**
 * CLI valuation command — PE, PEG, fair price range for a symbol.
 */
import type Database from 'better-sqlite3';
import { PricingRepository } from '../../shared/repositories/pricing-repository';
import { ValuationRepository, type ValuationRecord } from '../../shared/repositories/valuation-repository';
import {
  getPegRating,
  calculateFairPriceRange,
  type PegRating,
  type FairPriceRange,
} from '../../shared/analytics/valuation';

export interface ValuationResult {
  symbol: string;
  currentPrice: number;
  metrics: ValuationRecord | null;
  computedPegRating: PegRating | null;
  computedFairRange: FairPriceRange | null;
}

export function run(args: string[], db: Database.Database): ValuationResult {
  const symbol = args[0];
  if (!symbol) throw new Error('Usage: valuation <symbol>');

  const priceRepo = new PricingRepository(db);
  const valRepo = new ValuationRepository(db);

  const currentPrice = priceRepo.getLatestPrice(symbol);
  if (currentPrice == null) throw new Error(`No price data for ${symbol}`);

  const metrics = valRepo.getLatest(symbol);

  let computedPegRating: PegRating | null = null;
  let computedFairRange: FairPriceRange | null = null;

  if (metrics) {
    computedPegRating = getPegRating(metrics.forwardPeg);

    if (metrics.forwardEps != null && metrics.forwardPe != null) {
      computedFairRange = calculateFairPriceRange({
        eps: metrics.forwardEps,
        pe: metrics.forwardPe,
        epsGrowthPct: metrics.epsGrowthPct,
        isAdr: false, // TODO: detect from security metadata
      });
    }
  }

  return { symbol, currentPrice, metrics, computedPegRating, computedFairRange };
}
