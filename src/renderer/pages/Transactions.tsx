import { useEffect, useState } from 'react';
import { useTransactions, useAccounts, useSecurities } from '../hooks/useApi';
import type { Transaction, Security } from '../../shared/types';
import { format } from 'date-fns';
import TransactionImportModal from '../components/TransactionImportModal';

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

export default function Transactions() {
  const { transactions, loading, error, fetchTransactions, createTransaction, deleteTransaction } = useTransactions();
  const { accounts, fetchAccounts } = useAccounts();
  const { securities, fetchSecurities, createSecurity, findBySymbol } = useSecurities();
  const [showModal, setShowModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [filterAccount, setFilterAccount] = useState<string>('');
  const [filterType, setFilterType] = useState<string>('');
  const [filterSymbol, setFilterSymbol] = useState<string>('');
  const [filterSide, setFilterSide] = useState<string>('');
  const [formData, setFormData] = useState({
    accountId: '',
    symbol: '',
    name: '',
    securityType: 'stock' as Security['type'],
    type: 'buy' as Transaction['type'],
    date: format(new Date(), 'yyyy-MM-dd'),
    quantity: '',
    price: '',
    fees: '',
    notes: '',
  });

  useEffect(() => {
    fetchTransactions();
    fetchAccounts();
    fetchSecurities();
  }, [fetchTransactions, fetchAccounts, fetchSecurities]);

  const securityMap = new Map(securities.map(s => [s.id, s]));
  const accountMap = new Map(accounts.map(a => [a.id, a]));

  // Unique symbols for filter dropdown
  const uniqueSymbols = Array.from(
    new Set(transactions.map(t => securityMap.get(t.securityId)?.symbol).filter(Boolean))
  ).sort() as string[];

  const filteredTransactions = transactions.filter(t => {
    if (filterAccount && t.accountId !== filterAccount) return false;
    if (filterType && t.type !== filterType) return false;
    if (filterSymbol) {
      const sym = securityMap.get(t.securityId)?.symbol;
      if (sym !== filterSymbol) return false;
    }
    if (filterSide) {
      if (filterSide === 'buy' && t.type !== 'buy') return false;
      if (filterSide === 'sell' && t.type !== 'sell') return false;
    }
    return true;
  });

  const handleOpenModal = () => {
    setFormData({
      accountId: accounts[0]?.id || '',
      symbol: '',
      name: '',
      securityType: 'stock',
      type: 'buy',
      date: format(new Date(), 'yyyy-MM-dd'),
      quantity: '',
      price: '',
      fees: '',
      notes: '',
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
      const price = parseFloat(formData.price);
      const fees = formData.fees ? parseFloat(formData.fees) : 0;
      const amount = quantity * price;

      await createTransaction({
        accountId: formData.accountId,
        securityId: security.id,
        type: formData.type,
        date: formData.date,
        quantity,
        price,
        amount,
        fees,
        notes: formData.notes || undefined,
      });

      handleCloseModal();
      fetchSecurities();
    } catch (err) {
      console.error('Failed to create transaction:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('Are you sure you want to delete this transaction?')) {
      try {
        await deleteTransaction(id);
      } catch (err) {
        console.error('Failed to delete transaction:', err);
      }
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(value);
  };

  const getTypeColor = (type: Transaction['type']) => {
    switch (type) {
      case 'buy':
      case 'transfer_in':
        return 'badge-success';
      case 'sell':
      case 'transfer_out':
        return 'badge-error';
      case 'dividend':
      case 'interest':
        return 'badge-info';
      default:
        return 'badge-warning';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Transactions</h1>
        <div className="flex gap-3">
          <button onClick={() => setShowImportModal(true)} className="btn-secondary">
            Import from Brokerage
          </button>
          <button onClick={handleOpenModal} className="btn-primary">
            Add Transaction
          </button>
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
          value={filterSymbol}
          onChange={(e) => setFilterSymbol(e.target.value)}
        >
          <option value="">All Tickers</option>
          {uniqueSymbols.map((sym) => (
            <option key={sym} value={sym}>{sym}</option>
          ))}
        </select>
        <select
          className="select w-36"
          value={filterSide}
          onChange={(e) => setFilterSide(e.target.value)}
        >
          <option value="">All Sides</option>
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </select>
        <select
          className="select w-48"
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
        >
          <option value="">All Types</option>
          {transactionTypes.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
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
      ) : filteredTransactions.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-500">No transactions yet.</p>
          <p className="text-sm text-gray-400 mt-1">Add transactions manually or import from Excel.</p>
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
                {filteredTransactions.map((transaction) => {
                  const security = securityMap.get(transaction.securityId);
                  const account = accountMap.get(transaction.accountId);
                  return (
                    <tr key={transaction.id} className="hover:bg-gray-50">
                      <td className="table-cell">{format(new Date(transaction.date), 'MMM d, yyyy')}</td>
                      <td className="table-cell">
                        <span className={`badge ${getTypeColor(transaction.type)} capitalize`}>
                          {transaction.type.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="table-cell font-medium">{security?.symbol || 'Unknown'}</td>
                      <td className="table-cell text-gray-500">{account?.name || 'Unknown'}</td>
                      <td className="table-cell text-right">{transaction.quantity.toLocaleString()}</td>
                      <td className="table-cell text-right">{formatCurrency(transaction.price)}</td>
                      <td className="table-cell text-right">{formatCurrency(transaction.amount)}</td>
                      <td className="table-cell text-right">
                        {transaction.fees ? formatCurrency(transaction.fees) : '-'}
                      </td>
                      <td className="table-cell text-gray-500 max-w-xs truncate">
                        {transaction.notes || '-'}
                      </td>
                      <td className="table-cell text-right">
                        <button
                          onClick={() => handleDelete(transaction.id)}
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
        onImportComplete={() => {
          fetchTransactions();
          fetchSecurities();
        }}
      />

      {/* Add Transaction Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Add Transaction</h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
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
                <div>
                  <label className="label">Transaction Type</label>
                  <select
                    className="select"
                    value={formData.type}
                    onChange={(e) => setFormData({ ...formData, type: e.target.value as Transaction['type'] })}
                    required
                  >
                    {transactionTypes.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </div>
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
                <label className="label">Security Name (Optional)</label>
                <input
                  type="text"
                  className="input"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g., Apple Inc."
                />
              </div>
              <div>
                <label className="label">Date</label>
                <input
                  type="date"
                  className="input"
                  value={formData.date}
                  onChange={(e) => setFormData({ ...formData, date: e.target.value })}
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
                  <label className="label">Price ($)</label>
                  <input
                    type="number"
                    step="0.0001"
                    className="input"
                    value={formData.price}
                    onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                    required
                  />
                </div>
              </div>
              <div>
                <label className="label">Fees ($ Optional)</label>
                <input
                  type="number"
                  step="0.01"
                  className="input"
                  value={formData.fees}
                  onChange={(e) => setFormData({ ...formData, fees: e.target.value })}
                  placeholder="0.00"
                />
              </div>
              <div>
                <label className="label">Notes (Optional)</label>
                <textarea
                  className="input"
                  rows={2}
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  placeholder="Any additional notes..."
                />
              </div>
              <div className="flex justify-end gap-3 pt-4">
                <button type="button" onClick={handleCloseModal} className="btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Add Transaction
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
