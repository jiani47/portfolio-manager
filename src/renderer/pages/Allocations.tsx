import { useEffect, useState, useMemo, useCallback } from 'react';
import { usePositions, useSecurities, usePositionIntents, useAnalytics } from '../hooks/useApi';
import { useStreamingQuotes } from '../hooks/useStreamingQuotes';
import type { PositionIntent } from '../../shared/types';

const TIER_COLORS: Record<string, string> = {
  'Core': '#3b82f6',
  'Growth': '#10b981',
  'Starter': '#f59e0b',
  'Watchlist': '#f97316',
};

interface AllocationRow {
  positionId: string;
  symbol: string;
  name: string;
  currentPct: number;
  targetPct: number | null;
  drift: number | null;
  beta: number | null;
  marketValue: number;
  tier: string | null;
  sector: string | null;
  isCash: boolean;
}

interface PendingChange {
  tier?: string;
  targetPct?: number | null;
}

export default function Allocations() {
  const { positions, loading: positionsLoading, fetchPositions } = usePositions();
  const { securities, fetchSecurities } = useSecurities();
  const { intents, fetchIntents } = usePositionIntents();
  const { positionBetas, analytics: portfolioAnalytics, fetchAnalytics } = useAnalytics();

  const [pendingChanges, setPendingChanges] = useState<Map<string, PendingChange>>(new Map());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    fetchPositions();
    fetchSecurities();
    fetchIntents();
    fetchAnalytics(90);
  }, [fetchPositions, fetchSecurities, fetchIntents, fetchAnalytics]);

  // Build security map
  const securityMap = useMemo(() => {
    const map = new Map();
    securities.forEach(s => map.set(s.id, s));
    return map;
  }, [securities]);

  // Build symbol list for streaming quotes
  const symbolList = useMemo(() => {
    return positions
      .map(p => securityMap.get(p.securityId)?.symbol)
      .filter((s): s is string => !!s);
  }, [positions, securityMap]);

  const { quotes: streamingQuotes } = useStreamingQuotes(symbolList);

  // Build beta map
  const betaMap = useMemo(() => {
    const map = new Map<string, number>();
    positionBetas.forEach(pb => map.set(pb.symbol, pb.beta));
    return map;
  }, [positionBetas]);

  // Build allocation rows
  const allocationRows = useMemo((): AllocationRow[] => {
    if (positions.length === 0) return [];

    const totalMV = positions.reduce((sum, pos) => {
      const security = securityMap.get(pos.securityId);
      if (!security) return sum;
      const quote = streamingQuotes.get(security.symbol);
      const price = quote?.last || (pos.marketValue && pos.quantity > 0 ? pos.marketValue / pos.quantity : 0);
      const mv = pos.quantity * price;
      return sum + mv;
    }, 0);

    if (totalMV === 0) return [];

    return positions.map(pos => {
      const security = securityMap.get(pos.securityId);
      if (!security) return null;

      const intent = intents.get(pos.id);
      const quote = streamingQuotes.get(security.symbol);
      const price = quote?.last || (pos.marketValue && pos.quantity > 0 ? pos.marketValue / pos.quantity : 0);
      const mv = pos.quantity * price;
      const currentPct = (mv / totalMV) * 100;

      const pending = pendingChanges.get(pos.id);
      const targetPct = pending?.targetPct !== undefined ? pending.targetPct : intent?.targetAllocationPct ?? null;
      const tier = pending?.tier !== undefined ? pending.tier : intent?.tier ?? null;

      const drift = targetPct != null ? targetPct - currentPct : null;
      const beta = betaMap.get(security.symbol) ?? null;
      const isCash = security.type === 'cash';

      return {
        positionId: pos.id,
        symbol: security.symbol,
        name: security.name,
        currentPct,
        targetPct,
        drift,
        beta,
        marketValue: mv,
        tier,
        sector: security.sector ?? null,
        isCash,
      };
    }).filter((r): r is AllocationRow => r !== null);
  }, [positions, securityMap, intents, streamingQuotes, betaMap, pendingChanges]);

  // Split cash and equity
  const equityRows = useMemo(() => allocationRows.filter(r => !r.isCash).sort((a, b) => b.currentPct - a.currentPct), [allocationRows]);
  const cashRows = useMemo(() => allocationRows.filter(r => r.isCash), [allocationRows]);

  // Calculate totals
  const totals = useMemo(() => {
    const equityTargetSum = equityRows.reduce((sum, r) => sum + (r.targetPct ?? 0), 0);
    const cashTarget = 100 - equityTargetSum;
    const equityCurrentSum = equityRows.reduce((sum, r) => sum + r.currentPct, 0);
    const cashCurrent = cashRows.reduce((sum, r) => sum + r.currentPct, 0);

    return {
      equityTargetSum,
      cashTarget,
      equityCurrentSum,
      cashCurrent,
      isValid: equityTargetSum <= 100,
    };
  }, [equityRows, cashRows]);

  // Sector aggregation
  const sectorAllocation = useMemo(() => {
    const sectorMap = new Map<string, { currentPct: number; targetPct: number; count: number }>();

    equityRows.forEach(r => {
      const sector = r.sector || 'Unknown';
      const existing = sectorMap.get(sector) || { currentPct: 0, targetPct: 0, count: 0 };
      sectorMap.set(sector, {
        currentPct: existing.currentPct + r.currentPct,
        targetPct: existing.targetPct + (r.targetPct ?? 0),
        count: existing.count + 1,
      });
    });

    return Array.from(sectorMap.entries())
      .map(([sector, data]) => ({ sector, ...data }))
      .sort((a, b) => b.currentPct - a.currentPct);
  }, [equityRows]);

  // Available tiers for autocomplete
  const availableTiers = useMemo(() => {
    const tierSet = new Set<string>();
    if (intents && intents.size > 0) {
      Array.from(intents.values()).forEach(i => {
        if (i.tier) tierSet.add(i.tier);
      });
    }
    return Array.from(tierSet).sort();
  }, [intents]);

  const handleTierChange = useCallback((positionId: string, tier: string) => {
    setPendingChanges(prev => {
      const next = new Map(prev);
      const existing = next.get(positionId) || {};
      next.set(positionId, { ...existing, tier });
      return next;
    });
  }, []);

  const handleTargetChange = useCallback((positionId: string, value: string) => {
    const targetPct = value === '' ? null : parseFloat(value);
    if (targetPct !== null && (targetPct < 0 || targetPct > 100 || isNaN(targetPct))) return;

    setPendingChanges(prev => {
      const next = new Map(prev);
      const existing = next.get(positionId) || {};
      next.set(positionId, { ...existing, targetPct });
      return next;
    });
  }, []);

  const handleReset = useCallback(() => {
    setPendingChanges(new Map());
    setSaveError(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!totals.isValid) return;

    setSaving(true);
    setSaveError(null);

    try {
      for (const [positionId, changes] of pendingChanges.entries()) {
        const intent = intents.get(positionId);
        const updates: Partial<PositionIntent> = {};

        if (changes.tier !== undefined) updates.tier = changes.tier || undefined;
        if (changes.targetPct !== undefined) updates.targetAllocationPct = changes.targetPct ?? undefined;

        await window.electronAPI.upsertPositionIntent(positionId, {
          ...intent,
          ...updates,
        });
      }

      // Success - refresh data and clear pending
      await fetchIntents();
      setPendingChanges(new Map());
    } catch (error) {
      console.error('Save error:', error);
      setSaveError(error instanceof Error ? error.message : 'Failed to save changes');
    } finally {
      setSaving(false);
    }
  }, [pendingChanges, intents, totals.isValid, fetchIntents]);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(value);
  };

  if (positionsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading positions...</div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Portfolio Allocation</h1>
        <p className="text-sm text-gray-500 mt-1">Manage position tiers and target allocations</p>
      </div>

      {/* Summary Panel */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Portfolio Beta */}
        <div className="card">
          <h3 className="text-xs font-medium text-gray-500 mb-2">Portfolio Beta</h3>
          <div className="space-y-1">
            <div className="flex justify-between items-baseline">
              <span className="text-xs text-gray-600">Equity:</span>
              <span className="text-lg font-semibold text-gray-900">
                {portfolioAnalytics?.weightedBeta?.toFixed(2) ?? '—'}
              </span>
            </div>
            <div className="flex justify-between items-baseline">
              <span className="text-xs text-gray-600">With Cash:</span>
              <span className="text-sm font-medium text-gray-700">
                {portfolioAnalytics?.weightedBetaWithCash?.toFixed(2) ?? '—'}
              </span>
            </div>
          </div>
        </div>

        {/* Equity Target */}
        <div className="card">
          <h3 className="text-xs font-medium text-gray-500 mb-2">Equity Target</h3>
          <div className="text-2xl font-bold" style={{
            color: totals.equityTargetSum > 100 ? '#dc2626' : totals.equityTargetSum >= 95 ? '#f59e0b' : '#10b981'
          }}>
            {totals.equityTargetSum.toFixed(1)}%
          </div>
          <div className="text-xs text-gray-500 mt-1">
            Current: {totals.equityCurrentSum.toFixed(1)}%
          </div>
        </div>

        {/* Cash Target */}
        <div className="card">
          <h3 className="text-xs font-medium text-gray-500 mb-2">Cash Target</h3>
          <div className="text-2xl font-bold" style={{
            color: totals.cashTarget < 0 ? '#dc2626' : '#10b981'
          }}>
            {totals.cashTarget.toFixed(1)}%
          </div>
          <div className="text-xs text-gray-500 mt-1">
            Current: {totals.cashCurrent.toFixed(1)}%
          </div>
        </div>

        {/* Sector Count */}
        <div className="card">
          <h3 className="text-xs font-medium text-gray-500 mb-2">Sector Exposure</h3>
          <div className="text-2xl font-bold text-gray-900">
            {sectorAllocation.length}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {sectorAllocation.length === 1 ? 'sector' : 'sectors'}
          </div>
        </div>
      </div>

      {/* Sector Allocation Summary */}
      {sectorAllocation.length > 0 && (
        <div className="card">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Sector Allocation</h3>
          <div className="space-y-2">
            {sectorAllocation.map(s => (
              <div key={s.sector} className="flex items-center gap-3">
                <div className="w-32 text-xs text-gray-600 truncate" title={s.sector}>
                  {s.sector}
                </div>
                <div className="flex-1 bg-gray-100 rounded-full h-5 relative overflow-hidden">
                  <div
                    className="bg-blue-500 h-full rounded-full transition-all"
                    style={{ width: `${Math.min(s.currentPct, 100)}%` }}
                  />
                  {s.targetPct > 0 && (
                    <div
                      className="absolute top-0 h-full border-l-2 border-blue-800"
                      style={{ left: `${Math.min(s.targetPct, 100)}%` }}
                      title={`Target: ${s.targetPct.toFixed(1)}%`}
                    />
                  )}
                </div>
                <div className="w-20 text-xs text-gray-600 text-right tabular-nums">
                  {s.currentPct.toFixed(1)}%
                  {s.targetPct > 0 && (
                    <span className="text-gray-400"> / {s.targetPct.toFixed(1)}%</span>
                  )}
                </div>
                <div className="w-16 text-xs text-gray-500 text-right">
                  {s.count} {s.count === 1 ? 'pos' : 'pos'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Validation Error */}
      {!totals.isValid && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
          <span className="text-red-600 text-xl">⚠️</span>
          <div>
            <div className="text-sm font-medium text-red-900">Cannot save: Invalid allocation</div>
            <div className="text-xs text-red-700 mt-1">
              Total equity allocation is {totals.equityTargetSum.toFixed(1)}% (exceeds 100%).
              Cash would be {totals.cashTarget.toFixed(1)}%.
            </div>
          </div>
        </div>
      )}

      {/* Save Error */}
      {saveError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
          <span className="text-red-600 text-xl">⚠️</span>
          <div>
            <div className="text-sm font-medium text-red-900">Save failed</div>
            <div className="text-xs text-red-700 mt-1">{saveError}</div>
          </div>
        </div>
      )}

      {/* Allocation Table */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Equity Positions</h2>
          <div className="flex items-center gap-3">
            {pendingChanges.size > 0 && (
              <>
                <button
                  onClick={handleReset}
                  disabled={saving}
                  className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 disabled:opacity-50"
                >
                  Reset ({pendingChanges.size})
                </button>
                <button
                  onClick={handleSave}
                  disabled={!totals.isValid || saving}
                  className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </>
            )}
          </div>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500 border-b border-gray-200">
              <th className="text-left py-2 font-medium">Tier</th>
              <th className="text-left py-2 font-medium">Symbol</th>
              <th className="text-left py-2 font-medium">Name</th>
              <th className="text-right py-2 font-medium">Current %</th>
              <th className="text-right py-2 font-medium">Target %</th>
              <th className="text-right py-2 font-medium">Drift</th>
              <th className="text-right py-2 font-medium">Beta</th>
              <th className="text-right py-2 font-medium">Market Value</th>
            </tr>
          </thead>
          <tbody>
            {equityRows.map(row => {
              const tierColor = row.tier ? TIER_COLORS[row.tier] || '#9ca3af' : '#9ca3af';
              const absDrift = Math.abs(row.drift ?? 0);
              const driftColor = row.drift == null ? 'text-gray-400'
                : absDrift > 3 ? 'text-red-600'
                : absDrift > 1 ? 'text-amber-600'
                : 'text-gray-600';
              const hasPending = pendingChanges.has(row.positionId);

              return (
                <tr key={row.positionId} className={`border-b border-gray-100 hover:bg-gray-50 ${hasPending ? 'bg-blue-50' : ''}`}>
                  <td className="py-2">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: tierColor }} />
                      <input
                        type="text"
                        list="tier-options"
                        value={row.tier || ''}
                        onChange={(e) => handleTierChange(row.positionId, e.target.value)}
                        placeholder="—"
                        className="w-24 px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                  </td>
                  <td className="py-2">
                    <span className="font-medium text-gray-900">{row.symbol}</span>
                  </td>
                  <td className="py-2 text-gray-600 text-xs">{row.name}</td>
                  <td className="text-right py-2 tabular-nums text-gray-900">{row.currentPct.toFixed(1)}%</td>
                  <td className="text-right py-2">
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      max="100"
                      value={row.targetPct ?? ''}
                      onChange={(e) => handleTargetChange(row.positionId, e.target.value)}
                      placeholder="—"
                      className="w-16 px-2 py-1 text-xs text-right border border-gray-200 rounded tabular-nums focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </td>
                  <td className={`text-right py-2 tabular-nums ${driftColor}`}>
                    {row.drift != null ? `${row.drift > 0 ? '+' : ''}${row.drift.toFixed(1)}%` : '—'}
                  </td>
                  <td className="text-right py-2 tabular-nums text-gray-600">
                    {row.beta?.toFixed(2) ?? '—'}
                  </td>
                  <td className="text-right py-2 tabular-nums text-gray-600">
                    {formatCurrency(row.marketValue)}
                  </td>
                </tr>
              );
            })}

            {/* Cash Row */}
            {cashRows.map(row => (
              <tr key={row.positionId} className="border-t-2 border-gray-300 bg-gray-50">
                <td className="py-2">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full flex-shrink-0 bg-gray-400" />
                    <span className="text-xs text-gray-500">Cash</span>
                  </div>
                </td>
                <td className="py-2">
                  <span className="font-medium text-gray-700">{row.symbol}</span>
                </td>
                <td className="py-2 text-gray-500 text-xs">Cash Position</td>
                <td className="text-right py-2 tabular-nums text-gray-900">{row.currentPct.toFixed(1)}%</td>
                <td className="text-right py-2">
                  <span className={`text-xs tabular-nums ${totals.cashTarget < 0 ? 'text-red-600 font-medium' : 'text-gray-600'}`}>
                    {totals.cashTarget.toFixed(1)}%
                  </span>
                  <span className="text-xs text-gray-400 ml-1">(calc)</span>
                </td>
                <td className="text-right py-2 tabular-nums text-gray-600">
                  {(totals.cashTarget - row.currentPct).toFixed(1)}%
                </td>
                <td className="text-right py-2 text-gray-400">—</td>
                <td className="text-right py-2 tabular-nums text-gray-600">
                  {formatCurrency(row.marketValue)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Tier autocomplete datalist */}
      <datalist id="tier-options">
        {availableTiers.map(tier => (
          <option key={tier} value={tier} />
        ))}
      </datalist>
    </div>
  );
}
