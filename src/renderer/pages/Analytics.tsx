import { useEffect, useState } from 'react';
import { useAnalytics } from '../hooks/useApi';
import type { PortfolioAnalytics, PositionBeta } from '../../shared/types';

const PERIODS = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '180d', days: 180 },
  { label: '1Y', days: 365 },
];

function betaColor(beta: number): string {
  if (beta >= 1.5) return 'text-red-600';
  if (beta >= 1.2) return 'text-yellow-600';
  if (beta < 0.8) return 'text-blue-600';
  return 'text-gray-900';
}

function drawdownColor(dd: number): string {
  const abs = Math.abs(dd);
  if (abs >= 20) return 'text-red-600';
  if (abs >= 10) return 'text-yellow-600';
  return 'text-gray-900';
}

function sharpeColor(sr: number): string {
  if (sr < 0) return 'text-red-600';
  if (sr >= 2) return 'text-green-700';
  if (sr >= 1) return 'text-green-600';
  return 'text-gray-900';
}

function returnColor(val: number): string {
  return val >= 0 ? 'text-green-600' : 'text-red-600';
}

function formatPct(val: number, digits = 2): string {
  return `${val >= 0 ? '+' : ''}${val.toFixed(digits)}%`;
}

export default function Analytics() {
  const { analytics, positionBetas, loading, fetchAnalytics } = useAnalytics();
  const [selectedPeriod, setSelectedPeriod] = useState(90);

  useEffect(() => {
    fetchAnalytics(selectedPeriod);
  }, [selectedPeriod, fetchAnalytics]);

  const handlePeriodChange = (days: number) => {
    setSelectedPeriod(days);
  };

  const isEmpty = !analytics || analytics.dataPoints === 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Portfolio Analytics</h1>
        <div className="flex items-center gap-1">
          {PERIODS.map(p => (
            <button
              key={p.days}
              onClick={() => handlePeriodChange(p.days)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                selectedPeriod === p.days
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-500">Loading...</div>
        </div>
      ) : isEmpty ? (
        <div className="card">
          <div className="flex flex-col items-center justify-center py-16">
            <p className="text-gray-500 text-lg mb-2">Not enough snapshot data</p>
            <p className="text-gray-400 text-sm">
              Run <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono">pm-cli.sh snapshot</code> daily to build history.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Stat Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {/* Beta */}
            <div className="card">
              <p className="stat-label">Beta</p>
              <p className={`stat-value ${betaColor(analytics.weightedBeta)}`}>
                {analytics.weightedBeta.toFixed(2)}
              </p>
              <p className="text-xs text-gray-400 mt-1">vs SPY</p>
            </div>

            {/* Sharpe Ratio */}
            <div className="card">
              <p className="stat-label">Sharpe Ratio</p>
              <p className={`stat-value ${sharpeColor(analytics.sharpeRatio)}`}>
                {analytics.sharpeRatio.toFixed(2)}
              </p>
            </div>

            {/* Volatility */}
            <div className="card">
              <p className="stat-label">Volatility</p>
              <p className="stat-value">
                {(analytics.volatility * 100).toFixed(1)}%
              </p>
              <p className="text-xs text-gray-400 mt-1">annualized</p>
            </div>

            {/* Max Drawdown */}
            <div className="card">
              <p className="stat-label">Max Drawdown</p>
              <p className={`stat-value ${drawdownColor(analytics.maxDrawdown)}`}>
                -{Math.abs(analytics.maxDrawdown).toFixed(1)}%
              </p>
              <p className="text-xs text-gray-400 mt-1">{analytics.maxDrawdownDate}</p>
            </div>

            {/* Current Drawdown */}
            <div className="card">
              <p className="stat-label">Current Drawdown</p>
              <p className={`stat-value ${drawdownColor(analytics.currentDrawdown)}`}>
                -{Math.abs(analytics.currentDrawdown).toFixed(1)}%
              </p>
            </div>
          </div>

          {/* Returns Comparison */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="card">
              <p className="stat-label">Portfolio Return</p>
              <p className={`stat-value ${returnColor(analytics.totalReturn)}`}>
                {formatPct(analytics.totalReturn)}
              </p>
              <p className="text-xs text-gray-400 mt-1">{analytics.periodDays} days</p>
            </div>

            <div className="card">
              <p className="stat-label">Annualized Return</p>
              <p className={`stat-value ${returnColor(analytics.annualizedReturn)}`}>
                {formatPct(analytics.annualizedReturn)}
              </p>
            </div>

            <div className="card">
              <p className="stat-label">SPY Return</p>
              <p className={`stat-value ${returnColor(analytics.benchmarkReturn)}`}>
                {formatPct(analytics.benchmarkReturn)}
              </p>
              <p className="text-xs text-gray-400 mt-1">{analytics.periodDays} days</p>
            </div>
          </div>

          {/* Position Beta Table */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Position Betas</h2>
              <span className="text-xs text-gray-400">{analytics.dataPoints} data points</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-2 px-3 font-medium text-gray-500">Symbol</th>
                    <th className="text-right py-2 px-3 font-medium text-gray-500">Beta</th>
                    <th className="text-right py-2 px-3 font-medium text-gray-500">Correlation</th>
                    <th className="text-right py-2 px-3 font-medium text-gray-500">Weight (%)</th>
                    <th className="text-right py-2 px-3 font-medium text-gray-500">Weighted Beta</th>
                  </tr>
                </thead>
                <tbody>
                  {positionBetas.map(pb => (
                    <tr key={pb.symbol} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="py-2 px-3 font-medium text-gray-900">{pb.symbol}</td>
                      <td className={`py-2 px-3 text-right font-medium ${betaColor(pb.beta)}`}>
                        {pb.beta.toFixed(2)}
                      </td>
                      <td className="py-2 px-3 text-right text-gray-700">
                        {pb.correlation.toFixed(2)}
                      </td>
                      <td className="py-2 px-3 text-right text-gray-700">
                        {(pb.weight * 100).toFixed(1)}
                      </td>
                      <td className="py-2 px-3 text-right text-gray-700">
                        {pb.weightedBeta.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-300">
                    <td className="py-2 px-3 font-semibold text-gray-900">Total</td>
                    <td className="py-2 px-3"></td>
                    <td className="py-2 px-3"></td>
                    <td className="py-2 px-3"></td>
                    <td className="py-2 px-3 text-right font-semibold text-gray-900">
                      {positionBetas.reduce((sum, pb) => sum + pb.weightedBeta, 0).toFixed(2)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
