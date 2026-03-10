import { useEffect, useState, useMemo, useCallback } from 'react';
import { useTransactions, useSecurities, usePositions, usePortfolio } from '../hooks/useApi';
import { format, startOfMonth } from 'date-fns';

interface TickerSummary {
  symbol: string;
  qtySold: number;
  avgSold: number;
  qtyBought: number;
  avgBought: number;
  netChg: number;
  realizedPnl: number;
  unrealizedPnl: number;
  avgCost: number | null;
  mtm: number | null;
}

export default function ActiveManagement() {
  const { transactions, loading, fetchTransactions } = useTransactions();
  const { securities, fetchSecurities } = useSecurities();
  const { positions, fetchPositions } = usePositions();
  const { summary, fetchSummary } = usePortfolio();

  const [startDate, setStartDate] = useState(() => format(startOfMonth(new Date()), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));

  const loadData = useCallback(() => {
    fetchTransactions({ startDate, endDate });
    fetchSecurities();
    fetchPositions();
    fetchSummary();
  }, [fetchTransactions, fetchSecurities, fetchPositions, fetchSummary, startDate, endDate]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const securityMap = useMemo(() => new Map(securities.map(s => [s.id, s])), [securities]);

  // Build latest price map and avg cost map from positions
  const priceMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of positions) {
      const sec = securityMap.get(p.securityId);
      if (!sec || sec.type === 'cash') continue;
      if (p.currentPrice && p.currentPrice > 0) {
        m.set(sec.symbol, p.currentPrice);
      }
    }
    return m;
  }, [positions, securityMap]);

  const avgCostMap = useMemo(() => {
    const m = new Map<string, { totalCost: number; totalQty: number }>();
    for (const p of positions) {
      const sec = securityMap.get(p.securityId);
      if (!sec || sec.type === 'cash') continue;
      const existing = m.get(sec.symbol);
      if (existing) {
        existing.totalCost += p.costBasis;
        existing.totalQty += p.quantity;
      } else {
        m.set(sec.symbol, { totalCost: p.costBasis, totalQty: p.quantity });
      }
    }
    return m;
  }, [positions, securityMap]);

  // Aggregate transactions by symbol
  const tickerSummaries = useMemo(() => {
    const buySell = transactions.filter(t => t.type === 'buy' || t.type === 'sell');

    // Group by symbol
    const grouped = new Map<string, { buyQty: number; buyAmt: number; sellQty: number; sellAmt: number }>();
    for (const t of buySell) {
      const sec = securityMap.get(t.securityId);
      if (!sec || sec.symbol === 'CURRENCY_USD') continue;

      let entry = grouped.get(sec.symbol);
      if (!entry) {
        entry = { buyQty: 0, buyAmt: 0, sellQty: 0, sellAmt: 0 };
        grouped.set(sec.symbol, entry);
      }

      if (t.type === 'buy') {
        entry.buyQty += t.quantity;
        entry.buyAmt += Math.abs(t.amount);
      } else {
        entry.sellQty += t.quantity;
        entry.sellAmt += Math.abs(t.amount);
      }
    }

    // Compute summaries
    const summaries: TickerSummary[] = [];
    for (const [symbol, data] of grouped) {
      const avgBought = data.buyQty > 0 ? data.buyAmt / data.buyQty : 0;
      const avgSold = data.sellQty > 0 ? data.sellAmt / data.sellQty : 0;
      const netChg = data.buyQty - data.sellQty;
      const roundTripQty = Math.min(data.buyQty, data.sellQty);

      const realizedPnl = roundTripQty > 0 ? roundTripQty * (avgSold - avgBought) : 0;

      const mtm = priceMap.get(symbol) || null;
      let unrealizedPnl = 0;
      if (netChg > 0 && mtm !== null) {
        // Net buy: unrealized on shares added
        unrealizedPnl = netChg * (mtm - avgBought);
      } else if (netChg < 0 && mtm !== null) {
        // Net sell: opportunity cost
        unrealizedPnl = Math.abs(netChg) * (avgSold - mtm);
      }

      const costEntry = avgCostMap.get(symbol);
      const avgCost = costEntry && costEntry.totalQty > 0 ? costEntry.totalCost / costEntry.totalQty : null;

      summaries.push({
        symbol,
        qtySold: data.sellQty,
        avgSold,
        qtyBought: data.buyQty,
        avgBought,
        netChg,
        realizedPnl,
        unrealizedPnl,
        avgCost,
        mtm,
      });
    }

    summaries.sort((a, b) => b.realizedPnl - a.realizedPnl);
    return summaries;
  }, [transactions, securityMap, priceMap, avgCostMap]);

  // Totals
  const totals = useMemo(() => {
    const realized = tickerSummaries.reduce((s, t) => s + t.realizedPnl, 0);
    const unrealized = tickerSummaries.reduce((s, t) => s + t.unrealizedPnl, 0);
    const total = realized + unrealized;
    const portfolioValue = summary?.totalValue || 0;
    const bps = portfolioValue > 0 ? (total / portfolioValue) * 10000 : 0;
    return { realized, unrealized, total, bps };
  }, [tickerSummaries, summary]);

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

  const formatPnl = (value: number) => {
    const formatted = formatCurrency(Math.abs(value));
    return value >= 0 ? `+${formatted}` : `-${formatted}`;
  };

  const pnlColor = (value: number) =>
    value > 0 ? 'text-green-600' : value < 0 ? 'text-red-600' : 'text-gray-500';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Active Management</h1>
        <div className="flex items-center gap-3">
          <input
            type="date"
            className="input w-40 text-sm"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
          />
          <span className="text-gray-400">to</span>
          <input
            type="date"
            className="input w-40 text-sm"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
          />
          <button onClick={loadData} className="btn-secondary text-sm">Refresh</button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card">
          <p className="stat-label">Realized P&L</p>
          <p className={`stat-value ${pnlColor(totals.realized)}`}>{formatPnl(totals.realized)}</p>
        </div>
        <div className="card">
          <p className="stat-label">Unrealized P&L</p>
          <p className={`stat-value ${pnlColor(totals.unrealized)}`}>{formatPnl(totals.unrealized)}</p>
        </div>
        <div className="card">
          <p className="stat-label">Total P&L</p>
          <p className={`stat-value ${pnlColor(totals.total)}`}>{formatPnl(totals.total)}</p>
        </div>
        <div className="card">
          <p className="stat-label">Cost (bps)</p>
          <p className={`stat-value ${pnlColor(totals.bps)}`}>{totals.bps >= 0 ? '+' : ''}{totals.bps.toFixed(1)} bps</p>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-500">Loading...</div>
        </div>
      ) : tickerSummaries.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-500">No buy/sell activity in this period.</p>
        </div>
      ) : (
        <div className="card overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="table-header">Ticker</th>
                  <th className="table-header text-right">Qty Sold</th>
                  <th className="table-header text-right">Avg Sold</th>
                  <th className="table-header text-right">Qty Bot</th>
                  <th className="table-header text-right">Avg Bot</th>
                  <th className="table-header text-right">Net Chg</th>
                  <th className="table-header text-right">Realized P&L</th>
                  <th className="table-header text-right">Unrealized P&L</th>
                  <th className="table-header text-right">Avg Cost</th>
                  <th className="table-header text-right">MTM</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {tickerSummaries.map(row => (
                  <tr key={row.symbol} className="hover:bg-gray-50">
                    <td className="table-cell font-medium">{row.symbol}</td>
                    <td className="table-cell text-right">{row.qtySold > 0 ? row.qtySold : '—'}</td>
                    <td className="table-cell text-right">{row.qtySold > 0 ? formatCurrency(row.avgSold) : '—'}</td>
                    <td className="table-cell text-right">{row.qtyBought > 0 ? row.qtyBought : '—'}</td>
                    <td className="table-cell text-right">{row.qtyBought > 0 ? formatCurrency(row.avgBought) : '—'}</td>
                    <td className="table-cell text-right font-medium">
                      <span className={row.netChg > 0 ? 'text-green-600' : row.netChg < 0 ? 'text-red-600' : ''}>
                        {row.netChg > 0 ? '+' : ''}{row.netChg}
                      </span>
                    </td>
                    <td className={`table-cell text-right font-medium ${pnlColor(row.realizedPnl)}`}>
                      {row.realizedPnl !== 0 ? formatPnl(row.realizedPnl) : '—'}
                    </td>
                    <td className={`table-cell text-right font-medium ${pnlColor(row.unrealizedPnl)}`}>
                      {row.netChg !== 0 ? formatPnl(row.unrealizedPnl) : '—'}
                    </td>
                    <td className="table-cell text-right">{row.avgCost !== null ? formatCurrency(row.avgCost) : '—'}</td>
                    <td className="table-cell text-right">{row.mtm !== null ? formatCurrency(row.mtm) : '—'}</td>
                  </tr>
                ))}
                {/* Totals row */}
                <tr className="bg-gray-50 font-semibold border-t-2 border-gray-300">
                  <td className="table-cell">Total</td>
                  <td className="table-cell" colSpan={5}></td>
                  <td className={`table-cell text-right ${pnlColor(totals.realized)}`}>{formatPnl(totals.realized)}</td>
                  <td className={`table-cell text-right ${pnlColor(totals.unrealized)}`}>{formatPnl(totals.unrealized)}</td>
                  <td className="table-cell"></td>
                  <td className="table-cell"></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
