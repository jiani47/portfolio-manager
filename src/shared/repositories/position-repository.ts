/**
 * PositionRepository — typed DB queries for positions with prices and intents.
 * All SQL lives here. Consumers get typed objects, never raw rows.
 */
import type Database from 'better-sqlite3';
import type { PositionInput } from '../analytics/allocation';

interface PositionRow {
  symbol: string;
  security_type: string;
  quantity: number;
  account_id: string;
  price: number;
  target_allocation_pct: number | null;
  tier: string | null;
}

export class PositionRepository {
  constructor(private db: Database.Database) {}

  /**
   * All non-zero positions with latest close price and intent data.
   * Used by allocation drift, sizing, and other analytics commands.
   */
  getAllForAllocation(): PositionInput[] {
    const rows = this.db.prepare(`
      SELECT
        s.symbol,
        s.type AS security_type,
        p.quantity,
        p.account_id,
        CASE
          WHEN s.type = 'cash' THEN 1
          ELSE COALESCE(
            (SELECT ph.close_price
             FROM price_history ph
             WHERE ph.security_id = p.security_id
             ORDER BY ph.date DESC
             LIMIT 1),
            0
          )
        END AS price,
        pi.target_allocation_pct,
        pi.tier
      FROM positions p
      JOIN securities s ON p.security_id = s.id
      LEFT JOIN position_intents pi ON pi.position_id = p.id
      WHERE p.quantity > 0
    `).all() as PositionRow[];

    return rows.map(r => ({
      symbol: r.symbol,
      quantity: r.quantity,
      price: r.price,
      securityType: r.security_type as PositionInput['securityType'],
      targetAllocationPct: r.target_allocation_pct ?? null,
      tier: r.tier || 'Untagged',
      accountId: r.account_id,
    }));
  }
}
