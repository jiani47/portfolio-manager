/**
 * CLI levels-refresh command — compute S/R from price history and write to DB.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { PricingRepository } from '../../shared/repositories/pricing-repository';
import { computeSupportResistance, type PriceLevel } from '../../shared/analytics/levels';

export interface LevelsResult {
  symbol: string;
  currentPrice: number;
  support: PriceLevel[];
  resistance: PriceLevel[];
}

export function run(args: string[], db: Database.Database): LevelsResult | LevelsResult[] {
  const symbol = args[0];
  const symbols = symbol
    ? [symbol.toUpperCase()]
    : getAllSymbols(db);

  const priceRepo = new PricingRepository(db);
  const results: LevelsResult[] = [];

  for (const sym of symbols) {
    const currentPrice = priceRepo.getLatestPrice(sym);
    if (currentPrice == null) continue;

    const bars = priceRepo.getOHLCV(sym, 180);
    if (bars.length < 15) continue;

    const { support, resistance } = computeSupportResistance(bars, currentPrice);

    // Write to DB if not readonly
    try {
      const now = new Date().toISOString();
      db.prepare("DELETE FROM price_levels WHERE symbol = ? AND source = 'swing'").run(sym);

      const insert = db.prepare(
        `INSERT OR REPLACE INTO price_levels (id, symbol, level_type, price, strength, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'swing', ?, ?)`
      );

      for (const level of support) {
        insert.run(randomUUID(), sym, 'support', level.price, level.strength, now, now);
      }
      for (const level of resistance) {
        insert.run(randomUUID(), sym, 'resistance', level.price, level.strength, now, now);
      }
    } catch {
      // DB is read-only (test mode) — skip writes
    }

    results.push({ symbol: sym, currentPrice, support, resistance });
  }

  if (symbol && results.length === 0) {
    throw new Error(`No price data or insufficient history for ${symbol}`);
  }

  return symbol ? results[0] : results;
}

function getAllSymbols(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT symbol FROM (
      SELECT s.symbol FROM positions p
      JOIN securities s ON p.security_id = s.id
      WHERE s.type != 'cash' AND s.symbol != ''
      UNION
      SELECT wi.symbol FROM watchlist_items wi WHERE wi.symbol != ''
    ) ORDER BY symbol
  `).all() as { symbol: string }[];
  return rows.map(r => r.symbol);
}
