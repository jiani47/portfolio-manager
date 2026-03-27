/**
 * Allocation drift calculation — pure functions, no DB dependency.
 *
 * Aggregates positions by symbol across accounts, computes current allocation
 * percentages, and calculates drift from target allocations.
 */

export interface PositionInput {
  symbol: string;
  quantity: number;
  price: number;
  securityType: 'stock' | 'etf' | 'mutual_fund' | 'bond' | 'option' | 'crypto' | 'cash' | 'other';
  targetAllocationPct: number | null;
  tier: string;
  accountId: string;
}

export interface AllocationInput {
  positions: PositionInput[];
}

export interface AllocationRow {
  symbol: string;
  currentPct: number;
  targetPct: number | null;
  driftPct: number | null;
  marketValue: number;
  targetMarketValue: number | null;
  tier: string;
}

export function calculateAllocationDrift(input: AllocationInput): AllocationRow[] {
  const { positions } = input;

  // Aggregate by symbol, separating cash and excluding options
  const symbolAgg = new Map<string, { mv: number; targetPct: number | null; tier: string }>();
  let cashMV = 0;

  for (const pos of positions) {
    if (pos.securityType === 'option') continue;

    if (pos.securityType === 'cash') {
      cashMV += pos.quantity;
      continue;
    }

    const mv = pos.price * pos.quantity;
    const existing = symbolAgg.get(pos.symbol);

    if (existing) {
      existing.mv += mv;
      // Prefer the intent that has a target set
      if (pos.targetAllocationPct != null && existing.targetPct == null) {
        existing.targetPct = pos.targetAllocationPct;
        existing.tier = pos.tier;
      }
      // Pick up a non-Untagged tier if current is Untagged
      if (pos.tier !== 'Untagged' && existing.tier === 'Untagged') {
        existing.tier = pos.tier;
      }
    } else {
      symbolAgg.set(pos.symbol, {
        mv,
        targetPct: pos.targetAllocationPct,
        tier: pos.tier,
      });
    }
  }

  // Total portfolio value includes cash
  const equityTotal = Array.from(symbolAgg.values()).reduce((s, a) => s + a.mv, 0);
  const totalPortfolioValue = equityTotal + cashMV;

  // Build equity rows
  const rows: AllocationRow[] = [];
  for (const [symbol, agg] of symbolAgg) {
    const currentPct = totalPortfolioValue > 0 ? (agg.mv / totalPortfolioValue) * 100 : 0;
    rows.push({
      symbol,
      currentPct,
      targetPct: agg.targetPct,
      driftPct: agg.targetPct != null ? currentPct - agg.targetPct : null,
      marketValue: agg.mv,
      targetMarketValue:
        agg.targetPct != null ? (agg.targetPct / 100) * totalPortfolioValue : null,
      tier: agg.tier,
    });
  }

  // Cash row — implied target is remainder after all equity targets
  const assignedTargetPct = rows.reduce((s, r) => s + (r.targetPct || 0), 0);
  const cashTargetPct = Math.max(0, 100 - assignedTargetPct);
  const cashCurrentPct = totalPortfolioValue > 0 ? (cashMV / totalPortfolioValue) * 100 : 0;

  rows.push({
    symbol: 'Cash',
    currentPct: cashCurrentPct,
    targetPct: cashTargetPct,
    driftPct: cashCurrentPct - cashTargetPct,
    marketValue: cashMV,
    targetMarketValue: (cashTargetPct / 100) * totalPortfolioValue,
    tier: 'Cash',
  });

  // Sort: highest absolute drift first, Cash always last
  rows.sort((a, b) => {
    if (a.symbol === 'Cash') return 1;
    if (b.symbol === 'Cash') return -1;
    const aDrift = Math.abs(a.driftPct ?? 0);
    const bDrift = Math.abs(b.driftPct ?? 0);
    return bDrift - aDrift;
  });

  return rows;
}
