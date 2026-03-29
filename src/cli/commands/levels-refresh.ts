/**
 * CLI levels-refresh command — compute S/R from price history.
 */
import type Database from 'better-sqlite3';
import { PricingRepository } from '../../shared/repositories/pricing-repository';
import { computeSupportResistance, type PriceLevel } from '../../shared/analytics/levels';

export interface LevelsResult {
  symbol: string;
  currentPrice: number;
  support: PriceLevel[];
  resistance: PriceLevel[];
}

export function run(args: string[], db: Database.Database): LevelsResult {
  const symbol = args[0];
  if (!symbol) throw new Error('Usage: levels-refresh <symbol>');

  const priceRepo = new PricingRepository(db);

  const currentPrice = priceRepo.getLatestPrice(symbol);
  if (currentPrice == null) throw new Error(`No price data for ${symbol}`);

  const bars = priceRepo.getOHLCV(symbol, 180);
  if (bars.length < 15) throw new Error(`Insufficient price history for ${symbol} (${bars.length} bars, need 15+)`);

  const { support, resistance } = computeSupportResistance(bars, currentPrice);

  return { symbol, currentPrice, support, resistance };
}
