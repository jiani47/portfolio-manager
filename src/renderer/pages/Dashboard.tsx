import { useEffect } from 'react';
import { usePortfolio, usePositions, useAccounts, useSecurities } from '../hooks/useApi';
import { PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';

const COLORS = ['#0ea5e9', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#6366f1', '#ec4899', '#14b8a6'];

export default function Dashboard() {
  const { summary, allocation, loading: portfolioLoading, fetchSummary } = usePortfolio();
  const { positions, loading: positionsLoading, fetchPositions } = usePositions();
  const { accounts, fetchAccounts } = useAccounts();
  const { securities, fetchSecurities } = useSecurities();

  useEffect(() => {
    fetchSummary();
    fetchPositions();
    fetchAccounts();
    fetchSecurities();
  }, [fetchSummary, fetchPositions, fetchAccounts, fetchSecurities]);

  const loading = portfolioLoading || positionsLoading;

  const securityMap = new Map(securities.map(s => [s.id, s]));
  const accountMap = new Map(accounts.map(a => [a.id, a]));

  const topPositions = positions
    .sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0))
    .slice(0, 5);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
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

          {/* Holdings Table */}
          <div className="card">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">All Holdings</h2>
            {positions.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="table-header">Symbol</th>
                      <th className="table-header">Account</th>
                      <th className="table-header text-right">Quantity</th>
                      <th className="table-header text-right">Cost Basis</th>
                      <th className="table-header text-right">Market Value</th>
                      <th className="table-header text-right">Gain/Loss</th>
                      <th className="table-header text-right">% Change</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {positions.map((position) => {
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
