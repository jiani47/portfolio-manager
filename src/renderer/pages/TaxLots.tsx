import { useEffect, useState } from 'react';
import { useTaxLots, useAccounts, useSecurities, useTransactions } from '../hooks/useApi';
import type { TaxLot, Security } from '../../shared/types';
import { format, differenceInDays } from 'date-fns';

export default function TaxLots() {
  const { taxLots, loading, error, fetchTaxLots, createTaxLot } = useTaxLots();
  const { accounts, fetchAccounts } = useAccounts();
  const { securities, fetchSecurities, createSecurity, findBySymbol } = useSecurities();
  const { transactions, fetchTransactions } = useTransactions();
  const [showModal, setShowModal] = useState(false);
  const [filterAccount, setFilterAccount] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('open');
  const [formData, setFormData] = useState({
    accountId: '',
    symbol: '',
    name: '',
    securityType: 'stock' as Security['type'],
    transactionId: '',
    acquisitionDate: format(new Date(), 'yyyy-MM-dd'),
    quantity: '',
    costBasis: '',
  });

  useEffect(() => {
    fetchTaxLots();
    fetchAccounts();
    fetchSecurities();
    fetchTransactions();
  }, [fetchTaxLots, fetchAccounts, fetchSecurities, fetchTransactions]);

  const securityMap = new Map(securities.map(s => [s.id, s]));
  const accountMap = new Map(accounts.map(a => [a.id, a]));

  const filteredTaxLots = taxLots.filter(t => {
    if (filterAccount && t.accountId !== filterAccount) return false;
    if (filterStatus === 'open' && !t.isOpen) return false;
    if (filterStatus === 'closed' && t.isOpen) return false;
    return true;
  });

  // Group by security for better display
  const groupedBySymbol = filteredTaxLots.reduce((acc, lot) => {
    const symbol = securityMap.get(lot.securityId)?.symbol || 'Unknown';
    if (!acc[symbol]) {
      acc[symbol] = [];
    }
    acc[symbol].push(lot);
    return acc;
  }, {} as Record<string, TaxLot[]>);

  const handleOpenModal = () => {
    setFormData({
      accountId: accounts[0]?.id || '',
      symbol: '',
      name: '',
      securityType: 'stock',
      transactionId: '',
      acquisitionDate: format(new Date(), 'yyyy-MM-dd'),
      quantity: '',
      costBasis: '',
    });
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      // Find or create security
      let security = await findBySymbol(formData.symbol);
      if (!security) {
        security = await createSecurity({
          symbol: formData.symbol.toUpperCase(),
          name: formData.name || formData.symbol.toUpperCase(),
          type: formData.securityType,
          currency: 'USD',
        });
      }

      const quantity = parseFloat(formData.quantity);
      const costBasis = parseFloat(formData.costBasis);
      const costPerShare = costBasis / quantity;

      await createTaxLot({
        accountId: formData.accountId,
        securityId: security.id,
        transactionId: formData.transactionId || 'manual-entry',
        acquisitionDate: formData.acquisitionDate,
        quantity,
        costBasis,
        costPerShare,
        remainingQuantity: quantity,
        isOpen: true,
      });

      handleCloseModal();
      fetchSecurities();
    } catch (err) {
      console.error('Failed to create tax lot:', err);
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(value);
  };

  const getDaysHeld = (acquisitionDate: string) => {
    return differenceInDays(new Date(), new Date(acquisitionDate));
  };

  const getHoldingPeriod = (acquisitionDate: string): 'short' | 'long' => {
    return getDaysHeld(acquisitionDate) >= 365 ? 'long' : 'short';
  };

  const calculateTotals = () => {
    const openLots = taxLots.filter(t => t.isOpen);
    const totalCostBasis = openLots.reduce((sum, lot) => sum + (lot.costPerShare * lot.remainingQuantity), 0);
    const totalQuantity = openLots.reduce((sum, lot) => sum + lot.remainingQuantity, 0);
    const closedLots = taxLots.filter(t => !t.isOpen);
    const totalRealizedGain = closedLots.reduce((sum, lot) => sum + (lot.realizedGain || 0), 0);
    const shortTermGains = closedLots
      .filter(t => t.holdingPeriod === 'short')
      .reduce((sum, lot) => sum + (lot.realizedGain || 0), 0);
    const longTermGains = closedLots
      .filter(t => t.holdingPeriod === 'long')
      .reduce((sum, lot) => sum + (lot.realizedGain || 0), 0);

    return { totalCostBasis, totalQuantity, totalRealizedGain, shortTermGains, longTermGains };
  };

  const totals = calculateTotals();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Tax Lots</h1>
        <button onClick={handleOpenModal} className="btn-primary">
          Add Tax Lot
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <div className="card">
          <p className="stat-label">Open Lots Cost Basis</p>
          <p className="stat-value text-lg">{formatCurrency(totals.totalCostBasis)}</p>
        </div>
        <div className="card">
          <p className="stat-label">Total Realized Gain/Loss</p>
          <p className={`stat-value text-lg ${totals.totalRealizedGain >= 0 ? 'positive' : 'negative'}`}>
            {formatCurrency(totals.totalRealizedGain)}
          </p>
        </div>
        <div className="card">
          <p className="stat-label">Short-Term Gains</p>
          <p className={`stat-value text-lg ${totals.shortTermGains >= 0 ? 'positive' : 'negative'}`}>
            {formatCurrency(totals.shortTermGains)}
          </p>
        </div>
        <div className="card">
          <p className="stat-label">Long-Term Gains</p>
          <p className={`stat-value text-lg ${totals.longTermGains >= 0 ? 'positive' : 'negative'}`}>
            {formatCurrency(totals.longTermGains)}
          </p>
        </div>
        <div className="card">
          <p className="stat-label">Open / Closed Lots</p>
          <p className="stat-value text-lg">
            {taxLots.filter(t => t.isOpen).length} / {taxLots.filter(t => !t.isOpen).length}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-4">
        <select
          className="select w-48"
          value={filterAccount}
          onChange={(e) => setFilterAccount(e.target.value)}
        >
          <option value="">All Accounts</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
        <select
          className="select w-48"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="">All Status</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
        </select>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-500">Loading...</div>
        </div>
      ) : Object.keys(groupedBySymbol).length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-500">No tax lots yet.</p>
          <p className="text-sm text-gray-400 mt-1">Add tax lots manually or import from Excel.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(groupedBySymbol).map(([symbol, lots]) => (
            <div key={symbol} className="card overflow-hidden p-0">
              <div className="bg-gray-50 px-4 py-3 border-b border-gray-200">
                <h3 className="font-semibold text-gray-900">{symbol}</h3>
                <p className="text-sm text-gray-500">
                  {lots.length} lot{lots.length > 1 ? 's' : ''} ·
                  {lots.filter(l => l.isOpen).reduce((sum, l) => sum + l.remainingQuantity, 0).toLocaleString()} shares remaining
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="table-header">Acquisition Date</th>
                      <th className="table-header">Account</th>
                      <th className="table-header text-right">Original Qty</th>
                      <th className="table-header text-right">Remaining Qty</th>
                      <th className="table-header text-right">Cost/Share</th>
                      <th className="table-header text-right">Total Cost</th>
                      <th className="table-header">Days Held</th>
                      <th className="table-header">Period</th>
                      <th className="table-header">Status</th>
                      {lots.some(l => !l.isOpen) && (
                        <th className="table-header text-right">Realized Gain</th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {lots.map((lot) => {
                      const account = accountMap.get(lot.accountId);
                      const daysHeld = getDaysHeld(lot.acquisitionDate);
                      const period = getHoldingPeriod(lot.acquisitionDate);
                      return (
                        <tr key={lot.id} className="hover:bg-gray-50">
                          <td className="table-cell">
                            {format(new Date(lot.acquisitionDate), 'MMM d, yyyy')}
                          </td>
                          <td className="table-cell text-gray-500">{account?.name || 'Unknown'}</td>
                          <td className="table-cell text-right">{lot.quantity.toLocaleString()}</td>
                          <td className="table-cell text-right">{lot.remainingQuantity.toLocaleString()}</td>
                          <td className="table-cell text-right">{formatCurrency(lot.costPerShare)}</td>
                          <td className="table-cell text-right">
                            {formatCurrency(lot.costPerShare * lot.remainingQuantity)}
                          </td>
                          <td className="table-cell">{daysHeld} days</td>
                          <td className="table-cell">
                            <span className={`badge ${period === 'long' ? 'badge-success' : 'badge-warning'}`}>
                              {period === 'long' ? 'Long-term' : 'Short-term'}
                            </span>
                          </td>
                          <td className="table-cell">
                            <span className={`badge ${lot.isOpen ? 'badge-info' : 'badge-success'}`}>
                              {lot.isOpen ? 'Open' : 'Closed'}
                            </span>
                          </td>
                          {lots.some(l => !l.isOpen) && (
                            <td className={`table-cell text-right ${(lot.realizedGain || 0) >= 0 ? 'positive' : 'negative'}`}>
                              {lot.realizedGain !== undefined ? formatCurrency(lot.realizedGain) : '-'}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Add Tax Lot</h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="label">Account</label>
                <select
                  className="select"
                  value={formData.accountId}
                  onChange={(e) => setFormData({ ...formData, accountId: e.target.value })}
                  required
                >
                  <option value="">Select Account</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Symbol</label>
                  <input
                    type="text"
                    className="input"
                    value={formData.symbol}
                    onChange={(e) => setFormData({ ...formData, symbol: e.target.value.toUpperCase() })}
                    placeholder="e.g., AAPL"
                    required
                  />
                </div>
                <div>
                  <label className="label">Security Type</label>
                  <select
                    className="select"
                    value={formData.securityType}
                    onChange={(e) => setFormData({ ...formData, securityType: e.target.value as Security['type'] })}
                  >
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
                <label className="label">Acquisition Date</label>
                <input
                  type="date"
                  className="input"
                  value={formData.acquisitionDate}
                  onChange={(e) => setFormData({ ...formData, acquisitionDate: e.target.value })}
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Quantity</label>
                  <input
                    type="number"
                    step="any"
                    className="input"
                    value={formData.quantity}
                    onChange={(e) => setFormData({ ...formData, quantity: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <label className="label">Total Cost Basis ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    value={formData.costBasis}
                    onChange={(e) => setFormData({ ...formData, costBasis: e.target.value })}
                    required
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-4">
                <button type="button" onClick={handleCloseModal} className="btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Add Tax Lot
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
