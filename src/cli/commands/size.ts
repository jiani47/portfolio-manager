/**
 * CLI size command — position sizing with ATR-adjusted tranches.
 * Loads position data, prices, S/R levels from repositories.
 */
import type Database from 'better-sqlite3';
import { PositionRepository } from '../../shared/repositories/position-repository';
import { PricingRepository } from '../../shared/repositories/pricing-repository';
import {
  calculatePositionSize,
  calculateTranches,
  type SizingResult,
  type Tranche,
} from '../../shared/analytics/sizing';

export interface SizeResult {
  symbol: string;
  currentPrice: number;
  sizing: SizingResult;
  tranches: Tranche[];
  atrPct: number | null;
  supportLevels: number[];
}

export function run(args: string[], db: Database.Database): SizeResult {
  const symbol = args[0];
  const targetOverride = args[1] ? parseFloat(args[1]) : null;

  if (!symbol) throw new Error('Usage: size <symbol> [target_pct]');

  const posRepo = new PositionRepository(db);
  const priceRepo = new PricingRepository(db);

  // Get current price
  const currentPrice = priceRepo.getLatestPrice(symbol);
  if (currentPrice == null) throw new Error(`No price data for ${symbol}`);

  // Get current position across all accounts
  const allPositions = posRepo.getAllForAllocation();
  const symbolPositions = allPositions.filter(p => p.symbol === symbol);
  const currentShares = symbolPositions.reduce((s, p) => s + p.quantity, 0);

  // Get tier from intent
  const tier = symbolPositions.find(p => p.tier !== 'Untagged')?.tier || 'Starter';

  // Portfolio total (non-cash equity + cash)
  const portfolioTotal = allPositions.reduce((s, p) => {
    if (p.securityType === 'cash') return s + p.quantity;
    return s + p.quantity * p.price;
  }, 0);

  // Sizing
  const sizing = calculatePositionSize({
    currentPrice,
    currentShares,
    portfolioTotal,
    tier,
    targetPctOverride: targetOverride,
  });

  // ATR and S/R for tranches
  const atrPct = priceRepo.getATRPercent(symbol, 14);
  const supportLevels = priceRepo.getSupportLevels(symbol);

  // Tranches (only if there's room to add)
  const tranches = sizing.roomShares > 0
    ? calculateTranches({
        addShares: sizing.roomShares,
        currentPrice,
        atrPct: atrPct ?? 0,
        supportLevels,
      })
    : [];

  return { symbol, currentPrice, sizing, tranches, atrPct, supportLevels };
}
