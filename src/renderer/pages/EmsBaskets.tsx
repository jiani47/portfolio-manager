import { useEffect, useState } from 'react';
import { useEmsBaskets } from '../hooks/useApi';
import type { EntryPlanTranche } from '../../shared/types';

export default function EmsBaskets() {
  const { baskets, activeBasket, loading, error, fetchBaskets, fetchBasket } = useEmsBaskets();
  const [selectedBasket, setSelectedBasket] = useState<string | null>(null);

  useEffect(() => {
    fetchBaskets();
  }, [fetchBaskets]);

  useEffect(() => {
    if (selectedBasket) {
      fetchBasket(selectedBasket);
    }
  }, [selectedBasket, fetchBasket]);

  // Auto-select first basket
  useEffect(() => {
    if (baskets.length > 0 && !selectedBasket) {
      setSelectedBasket(baskets[0].name);
    }
  }, [baskets, selectedBasket]);

  // Compute summary stats from activeBasket
  const stats = activeBasket?.plans?.reduce((acc, plan) => {
    (plan.tranches || []).forEach(t => {
      acc.total++;
      if (t.status === 'pending') acc.pending++;
      else if (t.status === 'triggered') acc.triggered++;
      else if (t.status === 'confirmed' || t.status === 'submitted') acc.submitted++;
      else if (t.status === 'filled') acc.filled++;
      else if (t.status === 'cancelled') acc.cancelled++;
    });
    return acc;
  }, { total: 0, pending: 0, triggered: 0, submitted: 0, filled: 0, cancelled: 0 }) || { total: 0, pending: 0, triggered: 0, submitted: 0, filled: 0, cancelled: 0 };

  // Flatten all tranches with plan info for the detail table
  const allTranches: Array<EntryPlanTranche & { symbol: string; side: string }> = [];
  if (activeBasket?.plans) {
    for (const plan of activeBasket.plans) {
      for (const tranche of (plan.tranches || [])) {
        allTranches.push({
          ...tranche,
          symbol: plan.symbol || '?',
          side: plan.side || 'buy',
        });
      }
    }
  }

  // Sort: sells first, then buys, then by symbol, then tranche number
  allTranches.sort((a, b) => {
    if (a.side !== b.side) return a.side === 'sell' ? -1 : 1;
    if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
    return (a.trancheNumber || 0) - (b.trancheNumber || 0);
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">EMS Baskets</h1>
          <p className="text-sm text-gray-500 mt-1">Read-only view -- execute orders via CLI</p>
        </div>
        <div className="flex items-center gap-3">
          {baskets.length > 1 && (
            <select
              value={selectedBasket || ''}
              onChange={e => setSelectedBasket(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              {baskets.map(b => (
                <option key={b.id} value={b.name}>{b.name} ({b.status})</option>
              ))}
            </select>
          )}
          <button
            onClick={() => { fetchBaskets(); if (selectedBasket) fetchBasket(selectedBasket); }}
            disabled={loading}
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200 disabled:opacity-50"
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">{error}</div>
      )}

      {/* Summary cards */}
      {activeBasket && (
        <div className="grid grid-cols-6 gap-4">
          {[
            { label: 'Total', value: stats.total, color: 'text-gray-900' },
            { label: 'Pending', value: stats.pending, color: 'text-gray-500' },
            { label: 'Triggered', value: stats.triggered, color: 'text-yellow-600' },
            { label: 'Submitted', value: stats.submitted, color: 'text-blue-600' },
            { label: 'Filled', value: stats.filled, color: 'text-green-600' },
            { label: 'Cancelled', value: stats.cancelled, color: 'text-red-500' },
          ].map(card => (
            <div key={card.label} className="bg-white rounded-lg border border-gray-200 p-4 text-center">
              <div className={`text-2xl font-bold ${card.color}`}>{card.value}</div>
              <div className="text-xs text-gray-500 mt-1">{card.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Progress bar */}
      {activeBasket && stats.total > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex justify-between text-sm text-gray-600 mb-2">
            <span>{activeBasket.name}</span>
            <span>{stats.filled} of {stats.total} tranches filled ({Math.round(stats.filled / stats.total * 100)}%)</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-3">
            <div className="flex rounded-full h-3 overflow-hidden">
              <div className="bg-green-500" style={{ width: `${stats.filled / stats.total * 100}%` }}></div>
              <div className="bg-blue-500" style={{ width: `${stats.submitted / stats.total * 100}%` }}></div>
              <div className="bg-yellow-400" style={{ width: `${stats.triggered / stats.total * 100}%` }}></div>
            </div>
          </div>
          <div className="flex gap-4 mt-2 text-xs text-gray-500">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 inline-block"></span> Filled</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500 inline-block"></span> Submitted</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-400 inline-block"></span> Triggered</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gray-300 inline-block"></span> Pending</span>
          </div>
        </div>
      )}

      {/* No baskets state */}
      {!loading && baskets.length === 0 && !error && (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
          <p className="text-gray-500">No EMS baskets found. Create one via CLI:</p>
          <code className="mt-2 block text-sm text-gray-600 bg-gray-50 rounded px-4 py-2 inline-block">pm-cli.sh basket-create &lt;name&gt;</code>
        </div>
      )}

      {/* Tranche detail table */}
      {activeBasket && (
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Tranches</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Symbol</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Side</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">#</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Trigger</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Qty</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Limit</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Fill Px</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Fill Qty</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Broker</th>
                </tr>
              </thead>
              <tbody>
                {allTranches.length === 0 ? (
                  <tr><td colSpan={10} className="px-4 py-8 text-center text-gray-400">
                    {loading ? 'Loading...' : 'No tranches'}
                  </td></tr>
                ) : allTranches.map((t, i) => (
                  <tr key={t.id || i} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{t.symbol}</td>
                    <td className="px-4 py-3">
                      <span className={t.side === 'sell' ? 'text-red-600' : 'text-green-600'}>
                        {(t.side || 'buy').toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-500">{t.trancheNumber}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {t.triggerType === 'date' ? t.triggerDate : t.triggerPrice ? `$${t.triggerPrice.toFixed(2)}` : '-'}
                    </td>
                    <td className="px-4 py-3 text-right">{t.shares}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${getStatusBadge(t.status)}`}>
                        {t.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600">{t.limitPrice ? `$${t.limitPrice.toFixed(2)}` : ''}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{t.filledPrice ? `$${t.filledPrice.toFixed(2)}` : ''}</td>
                    <td className="px-4 py-3 text-right">
                      {t.filledQty ? (
                        <span className={t.filledQty >= t.shares ? 'text-green-600 font-medium' : 'text-yellow-600'}>
                          {t.filledQty}/{t.shares}
                        </span>
                      ) : ''}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{t.brokerageOrderStatus || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function getStatusBadge(status: string): string {
  switch (status) {
    case 'filled': return 'bg-green-100 text-green-700';
    case 'submitted': case 'confirmed': return 'bg-blue-100 text-blue-700';
    case 'triggered': return 'bg-yellow-100 text-yellow-700';
    case 'pending': return 'bg-gray-100 text-gray-600';
    case 'cancelled': return 'bg-red-100 text-red-600';
    case 'expired': return 'bg-orange-100 text-orange-600';
    default: return 'bg-gray-100 text-gray-600';
  }
}
