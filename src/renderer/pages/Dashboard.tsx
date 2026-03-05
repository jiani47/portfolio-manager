import { useEffect, useState, useMemo, useCallback } from 'react';
import { usePortfolio, usePositions, useAccounts, useSecurities, useEarnings, useSettings } from '../hooks/useApi';
import { PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import type { Position, EarningsEvent } from '../../shared/types';
import { format, addDays, parseISO } from 'date-fns';

const COLORS = ['#0ea5e9', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#6366f1', '#ec4899', '#14b8a6'];

type SortColumn = 'symbol' | 'account' | 'quantity' | 'costBasis' | 'marketValue' | 'gainLoss' | 'percentChange';
type SortDirection = 'asc' | 'desc';

export default function Dashboard() {
  const { summary, allocation, loading: portfolioLoading, fetchSummary } = usePortfolio();
  const { positions, loading: positionsLoading, fetchPositions } = usePositions();
  const { accounts, fetchAccounts } = useAccounts();
  const { securities, fetchSecurities } = useSecurities();
  const { earnings, loading: earningsLoading, fetchPortfolioEarnings } = useEarnings();
  const { settings, fetchSettings } = useSettings();
  const [sortColumn, setSortColumn] = useState<SortColumn>('marketValue');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const isDataProviderConfigured = settings?.dataProvider === 'schwab' || ((settings?.dataProvider === 'fmp' || settings?.dataProvider === 'massive') && settings?.dataProviderApiKey);

  const fetchEarnings = useCallback(() => {
    if (!isDataProviderConfigured) return;
    // Fetch earnings from yesterday (to ensure today is included) through next 30 days
    const fromDate = format(addDays(new Date(), -1), 'yyyy-MM-dd');
    const endDate = format(addDays(new Date(), 30), 'yyyy-MM-dd');
    fetchPortfolioEarnings(fromDate, endDate);
  }, [isDataProviderConfigured, fetchPortfolioEarnings]);

  useEffect(() => {
    fetchSummary();
    fetchPositions();
    fetchAccounts();
    fetchSecurities();
    fetchSettings();
  }, [fetchSummary, fetchPositions, fetchAccounts, fetchSecurities, fetchSettings]);

  // Fetch earnings when data provider is configured and positions are loaded
  useEffect(() => {
    if (isDataProviderConfigured && positions.length > 0) {
      fetchEarnings();
    }
  }, [isDataProviderConfigured, positions.length, fetchEarnings]);

  const loading = portfolioLoading || positionsLoading;

  const securityMap = new Map(securities.map(s => [s.id, s]));
  const accountMap = new Map(accounts.map(a => [a.id, a]));

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
  };

  const sortedPositions = useMemo(() => {
    const sorted = [...positions].sort((a, b) => {
      let aVal: string | number;
      let bVal: string | number;

      switch (sortColumn) {
        case 'symbol':
          aVal = securityMap.get(a.securityId)?.symbol || '';
          bVal = securityMap.get(b.securityId)?.symbol || '';
          break;
        case 'account':
          aVal = accountMap.get(a.accountId)?.name || '';
          bVal = accountMap.get(b.accountId)?.name || '';
          break;
        case 'quantity':
          aVal = a.quantity;
          bVal = b.quantity;
          break;
        case 'costBasis':
          aVal = a.costBasis;
          bVal = b.costBasis;
          break;
        case 'marketValue':
          aVal = a.marketValue || 0;
          bVal = b.marketValue || 0;
          break;
        case 'gainLoss':
          aVal = a.unrealizedGain || 0;
          bVal = b.unrealizedGain || 0;
          break;
        case 'percentChange':
          aVal = a.unrealizedGainPercent || 0;
          bVal = b.unrealizedGainPercent || 0;
          break;
        default:
          return 0;
      }

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc'
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      }

      return sortDirection === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });

    return sorted;
  }, [positions, sortColumn, sortDirection, securityMap, accountMap]);

  const SortIcon = ({ column }: { column: SortColumn }) => {
    if (sortColumn !== column) {
      return <span className="ml-1 text-gray-300">↕</span>;
    }
    return <span className="ml-1">{sortDirection === 'asc' ? '↑' : '↓'}</span>;
  };

  const topPositions = positions
    .sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0))
    .slice(0, 5);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  const formatPercent = (value: number) => {
    return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <button onClick={fetchSummary} className="btn-secondary text-sm">
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-500">Loading...</div>
        </div>
      ) : (
        <>
          {/* Summary Stats */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="card">
              <p className="stat-label">Total Portfolio Value</p>
              <p className="stat-value">{formatCurrency(summary?.totalValue || 0)}</p>
            </div>
            <div className="card">
              <p className="stat-label">Total Cost Basis</p>
              <p className="stat-value">{formatCurrency(summary?.totalCostBasis || 0)}</p>
            </div>
            <div className="card">
              <p className="stat-label">Unrealized Gain/Loss</p>
              <p className={`stat-value ${(summary?.totalUnrealizedGain || 0) >= 0 ? 'positive' : 'negative'}`}>
                {formatCurrency(summary?.totalUnrealizedGain || 0)}
              </p>
              <p className={`text-sm ${(summary?.totalUnrealizedGainPercent || 0) >= 0 ? 'positive' : 'negative'}`}>
                {formatPercent(summary?.totalUnrealizedGainPercent || 0)}
              </p>
            </div>
            <div className="card">
              <p className="stat-label">Positions / Accounts</p>
              <p className="stat-value">{summary?.positionCount || 0} / {summary?.accountCount || 0}</p>
            </div>
          </div>

          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Asset Allocation Pie Chart */}
            <div className="card">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Asset Allocation</h2>
              {allocation.length > 0 ? (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={allocation}
                        dataKey="percentage"
                        nameKey="category"
                        cx="50%"
                        cy="50%"
                        outerRadius={80}
                        label={({ category, percentage }) => `${category}: ${percentage.toFixed(1)}%`}
                      >
                        {allocation.map((_, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value: number) => `${value.toFixed(1)}%`} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-64 flex items-center justify-center text-gray-500">
                  No positions to display
                </div>
              )}
            </div>

            {/* Top Holdings Bar Chart */}
            <div className="card">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Top Holdings</h2>
              {topPositions.length > 0 ? (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={topPositions.map(p => ({
                        symbol: securityMap.get(p.securityId)?.symbol || 'Unknown',
                        value: p.marketValue || 0,
                      }))}
                      layout="vertical"
                      margin={{ left: 60 }}
                    >
                      <XAxis type="number" tickFormatter={(v) => formatCurrency(v)} />
                      <YAxis type="category" dataKey="symbol" />
                      <Tooltip formatter={(value: number) => formatCurrency(value)} />
                      <Bar dataKey="value" fill="#0ea5e9" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-64 flex items-center justify-center text-gray-500">
                  No positions to display
                </div>
              )}
            </div>
          </div>

          {/* Upcoming Earnings */}
          {isDataProviderConfigured && (
            <div className="card">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-gray-900">Upcoming Earnings</h2>
                <button
                  onClick={fetchEarnings}
                  disabled={earningsLoading}
                  className="btn-secondary text-sm"
                >
                  {earningsLoading ? 'Loading...' : 'Refresh'}
                </button>
              </div>
              {earningsLoading ? (
                <div className="text-center py-8 text-gray-500">Loading earnings...</div>
              ) : earnings.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="table-header">Symbol</th>
                        <th className="table-header">Date</th>
                        <th className="table-header">Time</th>
                        <th className="table-header text-right">EPS Est.</th>
                        <th className="table-header text-right">EPS Actual</th>
                        <th className="table-header text-right">Revenue Est.</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {earnings
                        .filter(e => e.date >= format(new Date(), 'yyyy-MM-dd')) // Today and future only
                        .sort((a, b) => a.date.localeCompare(b.date))
                        .slice(0, 10)
                        .map((event, idx) => {
                          const eventDate = parseISO(event.date);
                          const isToday = format(new Date(), 'yyyy-MM-dd') === event.date;
                          return (
                            <tr
                              key={`${event.symbol}-${event.date}-${idx}`}
                              className={`hover:bg-gray-50 ${isToday ? 'bg-yellow-50' : ''}`}
                            >
                              <td className="table-cell font-medium">{event.symbol}</td>
                              <td className="table-cell">
                                <span className={isToday ? 'font-semibold text-yellow-700' : ''}>
                                  {format(eventDate, 'MMM d, yyyy')}
                                  {isToday && ' (Today)'}
                                </span>
                              </td>
                              <td className="table-cell text-gray-500">
                                {event.time === 'bmo' && 'Before Open'}
                                {event.time === 'amc' && 'After Close'}
                                {event.time === 'dmh' && 'During Hours'}
                                {!event.time && '-'}
                              </td>
                              <td className="table-cell text-right">
                                {event.epsEstimated !== undefined ? `$${event.epsEstimated.toFixed(2)}` : '-'}
                              </td>
                              <td className="table-cell text-right">
                                {event.epsActual !== undefined ? (
                                  <span className={event.epsActual >= (event.epsEstimated || 0) ? 'text-green-600' : 'text-red-600'}>
                                    ${event.epsActual.toFixed(2)}
                                  </span>
                                ) : '-'}
                              </td>
                              <td className="table-cell text-right">
                                {event.revenueEstimated !== undefined
                                  ? `$${(event.revenueEstimated / 1e9).toFixed(2)}B`
                                  : '-'}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                  {(() => {
                    const filteredCount = earnings.filter(e => e.date >= format(new Date(), 'yyyy-MM-dd')).length;
                    return filteredCount > 10 ? (
                      <div className="text-center py-2 text-sm text-gray-500">
                        Showing 10 of {filteredCount} upcoming earnings
                      </div>
                    ) : null;
                  })()}
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  No upcoming earnings for your holdings in the next 30 days
                </div>
              )}
            </div>
          )}

          {/* Holdings Table */}
          <div className="card">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">All Holdings</h2>
            {positions.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th
                        className="table-header cursor-pointer hover:bg-gray-100 select-none"
                        onClick={() => handleSort('symbol')}
                      >
                        Symbol<SortIcon column="symbol" />
                      </th>
                      <th
                        className="table-header cursor-pointer hover:bg-gray-100 select-none"
                        onClick={() => handleSort('account')}
                      >
                        Account<SortIcon column="account" />
                      </th>
                      <th
                        className="table-header text-right cursor-pointer hover:bg-gray-100 select-none"
                        onClick={() => handleSort('quantity')}
                      >
                        Quantity<SortIcon column="quantity" />
                      </th>
                      <th
                        className="table-header text-right cursor-pointer hover:bg-gray-100 select-none"
                        onClick={() => handleSort('costBasis')}
                      >
                        Cost Basis<SortIcon column="costBasis" />
                      </th>
                      <th
                        className="table-header text-right cursor-pointer hover:bg-gray-100 select-none"
                        onClick={() => handleSort('marketValue')}
                      >
                        Market Value<SortIcon column="marketValue" />
                      </th>
                      <th
                        className="table-header text-right cursor-pointer hover:bg-gray-100 select-none"
                        onClick={() => handleSort('gainLoss')}
                      >
                        Gain/Loss<SortIcon column="gainLoss" />
                      </th>
                      <th
                        className="table-header text-right cursor-pointer hover:bg-gray-100 select-none"
                        onClick={() => handleSort('percentChange')}
                      >
                        % Change<SortIcon column="percentChange" />
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {sortedPositions.map((position) => {
                      const security = securityMap.get(position.securityId);
                      const account = accountMap.get(position.accountId);
                      return (
                        <tr key={position.id} className="hover:bg-gray-50">
                          <td className="table-cell font-medium">{security?.symbol || 'Unknown'}</td>
                          <td className="table-cell text-gray-500">{account?.name || 'Unknown'}</td>
                          <td className="table-cell text-right">{position.quantity.toLocaleString()}</td>
                          <td className="table-cell text-right">{formatCurrency(position.costBasis)}</td>
                          <td className="table-cell text-right">{formatCurrency(position.marketValue || 0)}</td>
                          <td className={`table-cell text-right ${(position.unrealizedGain || 0) >= 0 ? 'positive' : 'negative'}`}>
                            {formatCurrency(position.unrealizedGain || 0)}
                          </td>
                          <td className={`table-cell text-right ${(position.unrealizedGainPercent || 0) >= 0 ? 'positive' : 'negative'}`}>
                            {formatPercent(position.unrealizedGainPercent || 0)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-12 text-gray-500">
                <p>No holdings yet.</p>
                <p className="text-sm mt-1">Add accounts and import transactions to get started.</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
