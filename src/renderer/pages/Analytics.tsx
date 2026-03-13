import { useEffect, useState, useMemo } from 'react';
import { useAnalytics, useTransactions, useAccounts, useSecurities, useTradeAnalytics } from '../hooks/useApi';
import type { PortfolioAnalytics, PositionBeta, Transaction, Security } from '../../shared/types';
import { format } from 'date-fns';
import TransactionImportModal from '../components/TransactionImportModal';

const PERIODS = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '180d', days: 180 },
  { label: '1Y', days: 365 },
];

const transactionTypes = [
  { value: 'buy', label: 'Buy' },
  { value: 'sell', label: 'Sell' },
  { value: 'dividend', label: 'Dividend' },
  { value: 'interest', label: 'Interest' },
  { value: 'transfer_in', label: 'Transfer In' },
  { value: 'transfer_out', label: 'Transfer Out' },
  { value: 'split', label: 'Stock Split' },
  { value: 'spinoff', label: 'Spinoff' },
  { value: 'fee', label: 'Fee' },
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

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function getTypeColor(type: Transaction['type']): string {
  switch (type) {
    case 'buy': case 'transfer_in': return 'badge-success';
    case 'sell': case 'transfer_out': return 'badge-error';
    case 'dividend': case 'interest': return 'badge-info';
    default: return 'badge-warning';
  }
}

export default function Analytics() {
  const { analytics, positionBetas, loading, fetchAnalytics } = useAnalytics();
  const { transactions, loading: txLoading, fetchTransactions, createTransaction, deleteTransaction } = useTransactions();
  const { accounts, fetchAccounts } = useAccounts();
  const { securities, fetchSecurities, createSecurity, findBySymbol } = useSecurities();
  const [selectedPeriod, setSelectedPeriod] = useState(90);
  const [activeTab, setActiveTab] = useState<'analytics' | 'transactions' | 'trade-performance'>('analytics');

  // Transaction state
  const [showTxModal, setShowTxModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [filterAccount, setFilterAccount] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterSymbol, setFilterSymbol] = useState('');
  const [filterSide, setFilterSide] = useState('');
  const [txFormData, setTxFormData] = useState({
    accountId: '', symbol: '', name: '', securityType: 'stock' as Security['type'],
    type: 'buy' as Transaction['type'], date: format(new Date(), 'yyyy-MM-dd'),
    quantity: '', price: '', fees: '', notes: '',
  });

  useEffect(() => {
    fetchAnalytics(selectedPeriod);
  }, [selectedPeriod, fetchAnalytics]);

  const { tradeAnalytics, loading: tpLoading, fetchTradeAnalytics } = useTradeAnalytics();

  useEffect(() => {
    if (activeTab === 'transactions') {
      fetchTransactions();
      fetchAccounts();
      fetchSecurities();
    }
  }, [activeTab, fetchTransactions, fetchAccounts, fetchSecurities]);

  useEffect(() => {
    if (activeTab === 'trade-performance') fetchTradeAnalytics();
  }, [activeTab, fetchTradeAnalytics]);

  const securityMap = useMemo(() => new Map(securities.map(s => [s.id, s])), [securities]);
  const accountMap = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);

  const uniqueSymbols = useMemo(() =>
    Array.from(new Set(transactions.map(t => securityMap.get(t.securityId)?.symbol).filter(Boolean))).sort() as string[],
    [transactions, securityMap]
  );

  const filteredTransactions = useMemo(() =>
    transactions.filter(t => {
      if (filterAccount && t.accountId !== filterAccount) return false;
      if (filterType && t.type !== filterType) return false;
      if (filterSymbol && securityMap.get(t.securityId)?.symbol !== filterSymbol) return false;
      if (filterSide === 'buy' && t.type !== 'buy') return false;
      if (filterSide === 'sell' && t.type !== 'sell') return false;
      return true;
    }),
    [transactions, filterAccount, filterType, filterSymbol, filterSide, securityMap]
  );

  const handleTxSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    let security = await findBySymbol(txFormData.symbol);
    if (!security) {
      security = await createSecurity({
        symbol: txFormData.symbol.toUpperCase(),
        name: txFormData.name || txFormData.symbol.toUpperCase(),
        type: txFormData.securityType, currency: 'USD',
      });
    }
    const quantity = parseFloat(txFormData.quantity);
    const price = parseFloat(txFormData.price);
    const fees = txFormData.fees ? parseFloat(txFormData.fees) : 0;
    await createTransaction({
      accountId: txFormData.accountId, securityId: security.id, type: txFormData.type,
      date: txFormData.date, quantity, price, amount: quantity * price, fees,
      notes: txFormData.notes || undefined,
    });
    setShowTxModal(false);
    fetchSecurities();
  };

  const isEmpty = !analytics || analytics.dataPoints === 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
          <div className="flex gap-1">
            {(['analytics', 'transactions', 'trade-performance'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  activeTab === tab
                    ? 'bg-blue-100 text-blue-700'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                }`}
              >
                {tab === 'analytics' ? 'Portfolio' : tab === 'transactions' ? 'Transactions' : 'Trade Performance'}
              </button>
            ))}
          </div>
        </div>
        {activeTab === 'analytics' && (
          <div className="flex items-center gap-1">
            {PERIODS.map(p => (
              <button
                key={p.days}
                onClick={() => setSelectedPeriod(p.days)}
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
        )}
        {activeTab === 'transactions' && (
          <div className="flex gap-3">
            <button onClick={() => setShowImportModal(true)} className="btn-secondary">Import from Brokerage</button>
            <button onClick={() => {
              setTxFormData({ accountId: accounts[0]?.id || '', symbol: '', name: '', securityType: 'stock', type: 'buy', date: format(new Date(), 'yyyy-MM-dd'), quantity: '', price: '', fees: '', notes: '' });
              setShowTxModal(true);
            }} className="btn-primary">Add Transaction</button>
          </div>
        )}
      </div>

      {activeTab === 'analytics' && (
        <>
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-gray-500">Loading...</div>
            </div>
          ) : (
            <>
              {isEmpty ? (
                <div className="card">
                  <div className="flex flex-col items-center justify-center py-8">
                    <p className="text-gray-500 mb-1">Portfolio-level analytics require daily snapshots</p>
                    <p className="text-gray-400 text-sm">
                      Run <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono">pm-cli.sh snapshot</code> daily to build history.
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  {/* Stat Cards */}
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                    <div className="card">
                      <p className="stat-label">Beta</p>
                      <p className={`stat-value ${betaColor(analytics!.weightedBeta)}`}>{analytics!.weightedBeta.toFixed(2)}</p>
                      <p className="text-xs text-gray-400 mt-1">vs SPY</p>
                    </div>
                    <div className="card">
                      <p className="stat-label">Sharpe Ratio</p>
                      {analytics!.dataPoints >= 30 ? (
                        <p className={`stat-value ${sharpeColor(analytics!.sharpeRatio)}`}>{analytics!.sharpeRatio.toFixed(2)}</p>
                      ) : (
                        <p className="text-xs text-gray-400 mt-2">Insufficient data, requires minimum 30 days</p>
                      )}
                    </div>
                    <div className="card">
                      <p className="stat-label">Volatility</p>
                      <p className="stat-value">{(analytics!.volatility * 100).toFixed(1)}%</p>
                      <p className="text-xs text-gray-400 mt-1">annualized</p>
                    </div>
                    <div className="card">
                      <p className="stat-label">Max Drawdown</p>
                      <p className={`stat-value ${drawdownColor(analytics!.maxDrawdown)}`}>-{Math.abs(analytics!.maxDrawdown).toFixed(1)}%</p>
                      <p className="text-xs text-gray-400 mt-1">{analytics!.maxDrawdownDate}</p>
                    </div>
                    <div className="card">
                      <p className="stat-label">Current Drawdown</p>
                      <p className={`stat-value ${drawdownColor(analytics!.currentDrawdown)}`}>-{Math.abs(analytics!.currentDrawdown).toFixed(1)}%</p>
                    </div>
                  </div>

                  {/* Returns Comparison */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="card">
                      <p className="stat-label">Portfolio Return</p>
                      <p className={`stat-value ${returnColor(analytics!.totalReturn)}`}>{formatPct(analytics!.totalReturn)}</p>
                      <p className="text-xs text-gray-400 mt-1">{analytics!.periodDays} days</p>
                    </div>
                    <div className="card">
                      <p className="stat-label">Annualized Return</p>
                      {analytics!.dataPoints >= 30 ? (
                        <p className={`stat-value ${returnColor(analytics!.annualizedReturn)}`}>{formatPct(analytics!.annualizedReturn)}</p>
                      ) : (
                        <p className="text-xs text-gray-400 mt-2">Insufficient data, requires minimum 30 days</p>
                      )}
                    </div>
                    <div className="card">
                      <p className="stat-label">SPY Return</p>
                      <p className={`stat-value ${returnColor(analytics!.benchmarkReturn)}`}>{formatPct(analytics!.benchmarkReturn)}</p>
                      <p className="text-xs text-gray-400 mt-1">{analytics!.periodDays} days</p>
                    </div>
                  </div>
                </>
              )}

              {/* Position Beta Table */}
              {positionBetas.length > 0 && (
                <div className="card">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold text-gray-900">Position Betas</h2>
                    <span className="text-xs text-gray-400">{selectedPeriod}d vs SPY</span>
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
                            <td className={`py-2 px-3 text-right font-medium ${betaColor(pb.beta)}`}>{pb.beta.toFixed(2)}</td>
                            <td className="py-2 px-3 text-right text-gray-700">{pb.correlation.toFixed(2)}</td>
                            <td className="py-2 px-3 text-right text-gray-700">{(pb.weight * 100).toFixed(1)}</td>
                            <td className="py-2 px-3 text-right text-gray-700">{pb.weightedBeta.toFixed(2)}</td>
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
              )}
            </>
          )}
        </>
      )}

      {activeTab === 'transactions' && (
        <>
          {/* Transactions Tab */}
          {/* Filters */}
          <div className="flex gap-4">
            <select className="select w-48" value={filterAccount} onChange={(e) => setFilterAccount(e.target.value)}>
              <option value="">All Accounts</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select className="select w-48" value={filterSymbol} onChange={(e) => setFilterSymbol(e.target.value)}>
              <option value="">All Tickers</option>
              {uniqueSymbols.map(sym => <option key={sym} value={sym}>{sym}</option>)}
            </select>
            <select className="select w-36" value={filterSide} onChange={(e) => setFilterSide(e.target.value)}>
              <option value="">All Sides</option>
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
            <select className="select w-48" value={filterType} onChange={(e) => setFilterType(e.target.value)}>
              <option value="">All Types</option>
              {transactionTypes.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}
            </select>
          </div>

          {txLoading ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-gray-500">Loading...</div>
            </div>
          ) : filteredTransactions.length === 0 ? (
            <div className="card text-center py-12">
              <p className="text-gray-500">No transactions yet.</p>
              <p className="text-sm text-gray-400 mt-1">Add transactions manually or import from your brokerage.</p>
            </div>
          ) : (
            <div className="card overflow-hidden p-0">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="table-header">Date</th>
                      <th className="table-header">Type</th>
                      <th className="table-header">Symbol</th>
                      <th className="table-header">Account</th>
                      <th className="table-header text-right">Quantity</th>
                      <th className="table-header text-right">Price</th>
                      <th className="table-header text-right">Amount</th>
                      <th className="table-header text-right">Fees</th>
                      <th className="table-header">Notes</th>
                      <th className="table-header text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {filteredTransactions.map(transaction => {
                      const security = securityMap.get(transaction.securityId);
                      const account = accountMap.get(transaction.accountId);
                      return (
                        <tr key={transaction.id} className="hover:bg-gray-50">
                          <td className="table-cell">{format(new Date(transaction.date), 'MMM d, yyyy')}</td>
                          <td className="table-cell">
                            <span className={`badge ${getTypeColor(transaction.type)} capitalize`}>{transaction.type.replace('_', ' ')}</span>
                          </td>
                          <td className="table-cell font-medium">{security?.symbol || 'Unknown'}</td>
                          <td className="table-cell text-gray-500">{account?.name || 'Unknown'}</td>
                          <td className="table-cell text-right">{transaction.quantity.toLocaleString()}</td>
                          <td className="table-cell text-right">{formatCurrency(transaction.price)}</td>
                          <td className="table-cell text-right">{formatCurrency(transaction.amount)}</td>
                          <td className="table-cell text-right">{transaction.fees ? formatCurrency(transaction.fees) : '-'}</td>
                          <td className="table-cell text-gray-500 max-w-xs truncate">{transaction.notes || '-'}</td>
                          <td className="table-cell text-right">
                            <button
                              onClick={async () => {
                                if (window.confirm('Delete this transaction?')) await deleteTransaction(transaction.id);
                              }}
                              className="text-red-600 hover:text-red-700"
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Import Modal */}
          <TransactionImportModal
            isOpen={showImportModal}
            onClose={() => setShowImportModal(false)}
            onImportComplete={() => { fetchTransactions(); fetchSecurities(); }}
          />

          {/* Add Transaction Modal */}
          {showTxModal && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
              <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Add Transaction</h2>
                <form onSubmit={handleTxSubmit} className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="label">Account</label>
                      <select className="select" value={txFormData.accountId} onChange={(e) => setTxFormData({ ...txFormData, accountId: e.target.value })} required>
                        <option value="">Select Account</option>
                        {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="label">Type</label>
                      <select className="select" value={txFormData.type} onChange={(e) => setTxFormData({ ...txFormData, type: e.target.value as Transaction['type'] })} required>
                        {transactionTypes.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="label">Symbol</label>
                      <input type="text" className="input" value={txFormData.symbol} onChange={(e) => setTxFormData({ ...txFormData, symbol: e.target.value.toUpperCase() })} placeholder="e.g., AAPL" required />
                    </div>
                    <div>
                      <label className="label">Security Type</label>
                      <select className="select" value={txFormData.securityType} onChange={(e) => setTxFormData({ ...txFormData, securityType: e.target.value as Security['type'] })}>
                        <option value="stock">Stock</option>
                        <option value="etf">ETF</option>
                        <option value="mutual_fund">Mutual Fund</option>
                        <option value="bond">Bond</option>
                        <option value="option">Option</option>
                        <option value="crypto">Crypto</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="label">Security Name (Optional)</label>
                    <input type="text" className="input" value={txFormData.name} onChange={(e) => setTxFormData({ ...txFormData, name: e.target.value })} placeholder="e.g., Apple Inc." />
                  </div>
                  <div>
                    <label className="label">Date</label>
                    <input type="date" className="input" value={txFormData.date} onChange={(e) => setTxFormData({ ...txFormData, date: e.target.value })} required />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="label">Quantity</label>
                      <input type="number" step="any" className="input" value={txFormData.quantity} onChange={(e) => setTxFormData({ ...txFormData, quantity: e.target.value })} required />
                    </div>
                    <div>
                      <label className="label">Price ($)</label>
                      <input type="number" step="0.0001" className="input" value={txFormData.price} onChange={(e) => setTxFormData({ ...txFormData, price: e.target.value })} required />
                    </div>
                  </div>
                  <div>
                    <label className="label">Fees ($, Optional)</label>
                    <input type="number" step="0.01" className="input" value={txFormData.fees} onChange={(e) => setTxFormData({ ...txFormData, fees: e.target.value })} placeholder="0.00" />
                  </div>
                  <div>
                    <label className="label">Notes (Optional)</label>
                    <textarea className="input" rows={2} value={txFormData.notes} onChange={(e) => setTxFormData({ ...txFormData, notes: e.target.value })} placeholder="Any additional notes..." />
                  </div>
                  <div className="flex justify-end gap-3 pt-4">
                    <button type="button" onClick={() => setShowTxModal(false)} className="btn-secondary">Cancel</button>
                    <button type="submit" className="btn-primary">Add Transaction</button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </>
      )}

      {activeTab === 'trade-performance' && (
        <>
          {tpLoading ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-gray-500">Loading...</div>
            </div>
          ) : !tradeAnalytics || tradeAnalytics.summary.totalTrades === 0 ? (
            <div className="card text-center py-12">
              <p className="text-gray-500">No closed trades found.</p>
              <p className="text-sm text-gray-400 mt-1">Analytics will appear once you have sell transactions matched to prior buys.</p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Summary Cards */}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                <div className="card">
                  <p className="stat-label">Total Trades</p>
                  <p className="stat-value">{tradeAnalytics.summary.totalTrades}</p>
                </div>
                <div className="card">
                  <p className="stat-label">Win Rate</p>
                  <p className={`stat-value ${tradeAnalytics.summary.winRate >= 50 ? 'text-green-600' : 'text-red-600'}`}>
                    {tradeAnalytics.summary.winRate.toFixed(1)}%
                  </p>
                  <p className="text-xs text-gray-400 mt-1">{tradeAnalytics.summary.wins}W / {tradeAnalytics.summary.losses}L</p>
                </div>
                <div className="card">
                  <p className="stat-label">Total P&L</p>
                  <p className={`stat-value ${returnColor(tradeAnalytics.summary.totalRealizedGain)}`}>
                    {formatCurrency(tradeAnalytics.summary.totalRealizedGain)}
                  </p>
                </div>
                <div className="card">
                  <p className="stat-label">Avg Win / Loss</p>
                  <p className="stat-value text-green-600">{formatCurrency(tradeAnalytics.summary.avgWin)}</p>
                  <p className="text-xs text-red-600 mt-1">{formatCurrency(tradeAnalytics.summary.avgLoss)}</p>
                </div>
                <div className="card">
                  <p className="stat-label">Profit Factor</p>
                  <p className={`stat-value ${tradeAnalytics.summary.profitFactor >= 1 ? 'text-green-600' : 'text-red-600'}`}>
                    {tradeAnalytics.summary.profitFactor === Infinity ? '\u221E' : tradeAnalytics.summary.profitFactor.toFixed(2)}
                  </p>
                </div>
              </div>

              {/* Breakdown Tables */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {[
                  { title: 'By Hold Period', data: tradeAnalytics.byHoldPeriod },
                  { title: 'By Regime at Entry', data: tradeAnalytics.byRegimeAtEntry },
                  { title: 'By Entry Style', data: tradeAnalytics.byEntryStyle },
                ].map(({ title, data }) => (
                  <div key={title} className="card">
                    <h3 className="text-sm font-semibold text-gray-900 mb-3">{title}</h3>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-200">
                          <th className="text-left py-1.5 font-medium text-gray-500">Label</th>
                          <th className="text-right py-1.5 font-medium text-gray-500">Trades</th>
                          <th className="text-right py-1.5 font-medium text-gray-500">Win%</th>
                          <th className="text-right py-1.5 font-medium text-gray-500">Total P&L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.map(row => (
                          <tr key={row.label} className="border-b border-gray-100">
                            <td className="py-1.5 text-gray-900 capitalize">{row.label}</td>
                            <td className="py-1.5 text-right text-gray-700">{row.count}</td>
                            <td className={`py-1.5 text-right font-medium ${row.winRate >= 50 ? 'text-green-600' : 'text-red-600'}`}>
                              {row.winRate.toFixed(0)}%
                            </td>
                            <td className={`py-1.5 text-right font-medium ${row.totalGain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {formatCurrency(row.totalGain)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>

              {/* Top Winners / Losers */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {[
                  { title: 'Top 5 Winners', trades: tradeAnalytics.topWinners, color: 'text-green-600' },
                  { title: 'Top 5 Losers', trades: tradeAnalytics.topLosers, color: 'text-red-600' },
                ].map(({ title, trades, color }) => (
                  <div key={title} className="card">
                    <h3 className="text-sm font-semibold text-gray-900 mb-3">{title}</h3>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-200">
                          <th className="text-left py-1.5 font-medium text-gray-500">Symbol</th>
                          <th className="text-right py-1.5 font-medium text-gray-500">Qty</th>
                          <th className="text-right py-1.5 font-medium text-gray-500">Buy</th>
                          <th className="text-right py-1.5 font-medium text-gray-500">Sell</th>
                          <th className="text-right py-1.5 font-medium text-gray-500">P&L</th>
                          <th className="text-right py-1.5 font-medium text-gray-500">Hold</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trades.map((t, i) => (
                          <tr key={i} className="border-b border-gray-100">
                            <td className="py-1.5 font-medium text-gray-900">{t.symbol}</td>
                            <td className="py-1.5 text-right text-gray-700">{t.quantity.toFixed(0)}</td>
                            <td className="py-1.5 text-right text-gray-700">${t.buyPrice.toFixed(2)}</td>
                            <td className="py-1.5 text-right text-gray-700">${t.sellPrice.toFixed(2)}</td>
                            <td className={`py-1.5 text-right font-medium ${color}`}>
                              {formatCurrency(t.realizedGain)}
                            </td>
                            <td className="py-1.5 text-right text-gray-500">{t.holdDays}d</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
