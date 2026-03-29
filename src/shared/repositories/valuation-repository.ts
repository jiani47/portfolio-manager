/**
 * ValuationRepository — PE, PEG, fair price range, EPS data.
 */
import type Database from 'better-sqlite3';

export interface ValuationRecord {
  symbol: string;
  date: string;
  trailingPe: number | null;
  forwardPe: number | null;
  peg: number | null;
  forwardPeg: number | null;
  psRatio: number | null;
  trailingEps: number | null;
  forwardEps: number | null;
  epsGrowthPct: number | null;
  fairLow: number | null;
  fairMid: number | null;
  fairHigh: number | null;
  pegRating: string | null;
}

interface ValuationRow {
  symbol: string;
  date: string;
  trailing_pe: number | null;
  forward_pe: number | null;
  peg: number | null;
  forward_peg: number | null;
  ps_ratio: number | null;
  trailing_eps: number | null;
  forward_eps: number | null;
  eps_growth_pct: number | null;
  fair_low: number | null;
  fair_mid: number | null;
  fair_high: number | null;
  peg_rating: string | null;
}

function mapRow(r: ValuationRow): ValuationRecord {
  return {
    symbol: r.symbol,
    date: r.date,
    trailingPe: r.trailing_pe,
    forwardPe: r.forward_pe,
    peg: r.peg,
    forwardPeg: r.forward_peg,
    psRatio: r.ps_ratio,
    trailingEps: r.trailing_eps,
    forwardEps: r.forward_eps,
    epsGrowthPct: r.eps_growth_pct,
    fairLow: r.fair_low,
    fairMid: r.fair_mid,
    fairHigh: r.fair_high,
    pegRating: r.peg_rating,
  };
}

export class ValuationRepository {
  constructor(private db: Database.Database) {}

  /** Most recent valuation metrics for a symbol. */
  getLatest(symbol: string): ValuationRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM valuation_metrics
      WHERE symbol = ?
      ORDER BY date DESC
      LIMIT 1
    `).get(symbol) as ValuationRow | undefined;

    return row ? mapRow(row) : null;
  }

  /** Latest valuation for each symbol (deduped). */
  getAll(): ValuationRecord[] {
    const rows = this.db.prepare(`
      SELECT vm.* FROM valuation_metrics vm
      INNER JOIN (
        SELECT symbol, MAX(date) as max_date
        FROM valuation_metrics
        GROUP BY symbol
      ) latest ON vm.symbol = latest.symbol AND vm.date = latest.max_date
      ORDER BY vm.symbol
    `).all() as ValuationRow[];

    return rows.map(mapRow);
  }
}
