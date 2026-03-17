import { useEffect, useState, useCallback } from 'react';
import type { BrokerPLRecord } from '../../shared/types';

type PLSummary = { symbol: string; totalGainLoss: number; lotCount: number; lastCloseDate: string };

export default function BrokerPL() {
  const [summary, setSummary] = useState<PLSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [lots, setLots] = useState<BrokerPLRecord[]>([]);
  const [lotsLoading, setLotsLoading] = useState(false);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    try {
      const data = await window.electronAPI.getBrokerPLSummary();
      setSummary(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  const handleSelectSymbol = async (symbol: string) => {
    setSelectedSymbol(symbol);
    setLotsLoading(true);
    try {
      const data = await window.electronAPI.getBrokerPLBySymbol(symbol);
      setLots(data);
    } finally {
      setLotsLoading(false);
    }
  };

  // Totals
  const totalPL = summary.reduce((sum, s) => sum + s.totalGainLoss, 0);
  const totalLots = summary.reduce((sum, s) => sum + s.lotCount, 0);
  const winners = summary.filter(s => s.totalGainLoss > 0);
  const losers = summary.filter(s => s.totalGainLoss < 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Broker P&L</h1>
        <p className="text-sm text-gray-500 mt-1">Realized gains/losses imported from Schwab CSV</p>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Total Realized P&L</p>
          <p className={`text-2xl font-bold ${totalPL >= 0 ? 'text-green-700' : 'text-red-700'}`}>
            ${totalPL >= 0 ? '+' : ''}{totalPL.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Symbols</p>
          <p className="text-2xl font-bold text-gray-900">{summary.length}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Lots Closed</p>
          <p className="text-2xl font-bold text-gray-900">{totalLots}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">W / L Symbols</p>
          <p className="text-2xl font-bold">
            <span className="text-green-700">{winners.length}</span>
            <span className="text-gray-400 mx-1">/</span>
            <span className="text-red-700">{losers.length}</span>
          </p>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-8 text-gray-400">Loading...</div>
      ) : summary.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg">No broker P&L data</p>
          <p className="text-sm mt-1">Use <code className="bg-gray-100 px-1 rounded">pm-cli.sh reconcile &lt;csv&gt;</code> to import Schwab realized P&L</p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-6">
          {/* Symbol list */}
          <div className="col-span-1 space-y-1">
            {summary.map(s => (
              <button
                key={s.symbol}
                onClick={() => handleSelectSymbol(s.symbol)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center justify-between ${
                  selectedSymbol === s.symbol ? 'bg-primary-50 border border-primary-300' : 'bg-white border hover:border-primary-200'
                }`}
              >
                <span className="font-medium text-gray-900">{s.symbol}</span>
                <span className={`font-medium ${s.totalGainLoss >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                  ${s.totalGainLoss >= 0 ? '+' : ''}{s.totalGainLoss.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              </button>
            ))}
          </div>

          {/* Lot details */}
          <div className="col-span-2">
            {!selectedSymbol ? (
              <div className="text-center py-12 text-gray-400">Select a symbol to view lot details</div>
            ) : lotsLoading ? (
              <div className="text-center py-8 text-gray-400">Loading lots...</div>
            ) : (
              <div className="bg-white rounded-lg border">
                <div className="px-4 py-3 border-b">
                  <h3 className="font-semibold text-gray-900">{selectedSymbol} — {lots.length} lots</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-gray-50 text-left text-xs text-gray-500">
                        <th className="px-3 py-2">Account</th>
                        <th className="px-3 py-2">Open</th>
                        <th className="px-3 py-2">Close</th>
                        <th className="px-3 py-2 text-right">Qty</th>
                        <th className="px-3 py-2 text-right">Cost</th>
                        <th className="px-3 py-2 text-right">Proceeds</th>
                        <th className="px-3 py-2 text-right">P&L</th>
                        <th className="px-3 py-2">Term</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lots.map(lot => (
                        <tr key={lot.id} className="border-b last:border-0">
                          <td className="px-3 py-2 text-gray-500 text-xs">{lot.accountName || '—'}</td>
                          <td className="px-3 py-2 text-gray-600">{lot.openDate || '—'}</td>
                          <td className="px-3 py-2 text-gray-600">{lot.closeDate || '—'}</td>
                          <td className="px-3 py-2 text-right">{lot.quantity}</td>
                          <td className="px-3 py-2 text-right">{lot.costBasis != null ? `$${lot.costBasis.toFixed(2)}` : '—'}</td>
                          <td className="px-3 py-2 text-right">{lot.proceeds != null ? `$${lot.proceeds.toFixed(2)}` : '—'}</td>
                          <td className={`px-3 py-2 text-right font-medium ${(lot.gainLoss ?? 0) >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                            {lot.gainLoss != null ? `$${lot.gainLoss >= 0 ? '+' : ''}${lot.gainLoss.toFixed(2)}` : '—'}
                          </td>
                          <td className="px-3 py-2 text-gray-500 text-xs">{lot.term || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
