/**
 * PricingRepository — latest prices, ATR, support/resistance levels.
 */
import type Database from 'better-sqlite3';

export class PricingRepository {
  constructor(private db: Database.Database) {}

  /** Latest close price for a symbol. */
  getLatestPrice(symbol: string): number | null {
    const row = this.db.prepare(`
      SELECT ph.close_price
      FROM price_history ph
      JOIN securities s ON ph.security_id = s.id
      WHERE s.symbol = ?
      ORDER BY ph.date DESC
      LIMIT 1
    `).get(symbol) as { close_price: number } | undefined;

    return row?.close_price ?? null;
  }

  /**
   * ATR as percentage of current price.
   * ATR = avg(high - low) over last N bars.
   * Returns (ATR / latestClose) × 100, or null if insufficient data.
   */
  getATRPercent(symbol: string, period = 14): number | null {
    const rows = this.db.prepare(`
      SELECT ph.high_price, ph.low_price, ph.close_price
      FROM price_history ph
      JOIN securities s ON ph.security_id = s.id
      WHERE s.symbol = ?
        AND ph.high_price IS NOT NULL
        AND ph.low_price IS NOT NULL
      ORDER BY ph.date DESC
      LIMIT ?
    `).all(symbol, period) as { high_price: number; low_price: number; close_price: number }[];

    if (rows.length < period) return null;

    const atr = rows.reduce((s, r) => s + (r.high_price - r.low_price), 0) / rows.length;
    const latestClose = rows[0].close_price;
    if (latestClose <= 0) return null;

    return (atr / latestClose) * 100;
  }

  /** Support levels below current price, sorted nearest first (descending). */
  getSupportLevels(symbol: string): number[] {
    const rows = this.db.prepare(`
      SELECT price
      FROM price_levels
      WHERE symbol = ? AND level_type = 'support'
      ORDER BY price DESC
    `).all(symbol) as { price: number }[];

    return rows.map(r => r.price);
  }

  /** Resistance levels above current price, sorted nearest first (ascending). */
  getResistanceLevels(symbol: string): number[] {
    const rows = this.db.prepare(`
      SELECT price
      FROM price_levels
      WHERE symbol = ? AND level_type = 'resistance'
      ORDER BY price ASC
    `).all(symbol) as { price: number }[];

    return rows.map(r => r.price);
  }
}
