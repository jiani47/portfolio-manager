import { useEffect, useState, useCallback } from 'react';

type DailyTotal = { date: string; totalMv: number; totalCost: number };

export default function PortfolioHistory() {
  const [dailyTotals, setDailyTotals] = useState<DailyTotal[]>([]);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(90);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const data = await window.electronAPI.getSnapshotDailyTotals(days);
      setDailyTotals(data);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Compute stats
  const latest = dailyTotals[dailyTotals.length - 1];
  const earliest = dailyTotals[0];
  const periodReturn = latest && earliest && earliest.totalMv > 0
    ? ((latest.totalMv - earliest.totalMv) / earliest.totalMv) * 100
    : 0;
  const unrealizedPnl = latest ? latest.totalMv - latest.totalCost : 0;

  // Simple sparkline using div bars
  const maxMv = Math.max(...dailyTotals.map(d => d.totalMv), 1);
  const minMv = Math.min(...dailyTotals.map(d => d.totalMv), 0);
  const range = maxMv - minMv || 1;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Portfolio History</h1>
          <p className="text-sm text-gray-500 mt-1">Daily snapshots of total portfolio value</p>
        </div>
        <div className="flex gap-2">
          {[30, 90, 180, 365].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                days === d ? 'bg-primary-50 border-primary-300 text-primary-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Stats */}
      {latest && (
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-white rounded-lg border p-4">
            <p className="text-sm text-gray-500">Current Value</p>
            <p className="text-2xl font-bold text-gray-900">
              ${latest.totalMv.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </p>
          </div>
          <div className="bg-white rounded-lg border p-4">
            <p className="text-sm text-gray-500">Cost Basis</p>
            <p className="text-2xl font-bold text-gray-900">
              ${latest.totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </p>
          </div>
          <div className="bg-white rounded-lg border p-4">
            <p className="text-sm text-gray-500">Unrealized P&L</p>
            <p className={`text-2xl font-bold ${unrealizedPnl >= 0 ? 'text-green-700' : 'text-red-700'}`}>
              ${unrealizedPnl >= 0 ? '+' : ''}{unrealizedPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </p>
          </div>
          <div className="bg-white rounded-lg border p-4">
            <p className="text-sm text-gray-500">{days}d Return</p>
            <p className={`text-2xl font-bold ${periodReturn >= 0 ? 'text-green-700' : 'text-red-700'}`}>
              {periodReturn >= 0 ? '+' : ''}{periodReturn.toFixed(1)}%
            </p>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-gray-400">Loading...</div>
      ) : dailyTotals.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg">No snapshot data</p>
          <p className="text-sm mt-1">Use <code className="bg-gray-100 px-1 rounded">pm-cli.sh snapshot</code> daily to build history</p>
        </div>
      ) : (
        <>
          {/* Chart area — simple bar visualization */}
          <div className="bg-white rounded-lg border p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Portfolio Value</h3>
            <div className="flex items-end gap-px" style={{ height: 200 }}>
              {dailyTotals.map((d, i) => {
                const pct = ((d.totalMv - minMv) / range) * 100;
                const isGain = d.totalMv >= d.totalCost;
                return (
                  <div
                    key={d.date}
                    className="flex-1 group relative"
                    style={{ height: '100%' }}
                  >
                    <div
                      className={`absolute bottom-0 w-full rounded-t-sm transition-colors ${
                        isGain ? 'bg-green-400 hover:bg-green-500' : 'bg-red-400 hover:bg-red-500'
                      }`}
                      style={{ height: `${Math.max(pct, 1)}%` }}
                    />
                    <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-xs rounded px-2 py-1 opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-10">
                      {d.date}: ${d.totalMv.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-xs text-gray-400 mt-2">
              <span>{dailyTotals[0]?.date}</span>
              <span>{dailyTotals[dailyTotals.length - 1]?.date}</span>
            </div>
          </div>

          {/* Daily table */}
          <div className="bg-white rounded-lg border">
            <div className="px-4 py-3 border-b">
              <h3 className="font-semibold text-gray-900">Daily Values</h3>
            </div>
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-50">
                  <tr className="border-b text-left text-xs text-gray-500">
                    <th className="px-4 py-2">Date</th>
                    <th className="px-4 py-2 text-right">Market Value</th>
                    <th className="px-4 py-2 text-right">Cost Basis</th>
                    <th className="px-4 py-2 text-right">Unrealized P&L</th>
                    <th className="px-4 py-2 text-right">Day Change</th>
                  </tr>
                </thead>
                <tbody>
                  {[...dailyTotals].reverse().map((d, i, arr) => {
                    const prev = arr[i + 1];
                    const dayChange = prev ? d.totalMv - prev.totalMv : 0;
                    const pnl = d.totalMv - d.totalCost;
                    return (
                      <tr key={d.date} className="border-b last:border-0">
                        <td className="px-4 py-2 text-gray-700">{d.date}</td>
                        <td className="px-4 py-2 text-right font-medium">
                          ${d.totalMv.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </td>
                        <td className="px-4 py-2 text-right text-gray-500">
                          ${d.totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </td>
                        <td className={`px-4 py-2 text-right ${pnl >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                          ${pnl >= 0 ? '+' : ''}{pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </td>
                        <td className={`px-4 py-2 text-right ${dayChange >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {prev ? `${dayChange >= 0 ? '+' : ''}$${dayChange.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
