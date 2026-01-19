import { useEffect, useState } from 'react';
import { usePositions, useAccounts, useSecurities } from '../hooks/useApi';
import BrokerageImportModal from '../components/BrokerageImportModal';
import type { Position, Security } from '../../shared/types';

export default function Holdings() {
  const { positions, loading, error, fetchPositions, createPosition, updatePosition, deletePosition } = usePositions();
  const { accounts, fetchAccounts } = useAccounts();
  const { securities, fetchSecurities, createSecurity, findBySymbol } = useSecurities();
  const [showModal, setShowModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [editingPosition, setEditingPosition] = useState<Position | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const [formData, setFormData] = useState({
    accountId: '',
    symbol: '',
    name: '',
    type: 'stock' as Security['type'],
    quantity: '',
    costBasis: '',
    currentPrice: '',
  });

  useEffect(() => {
    fetchPositions();
    fetchAccounts();
    fetchSecurities();
  }, [fetchPositions, fetchAccounts, fetchSecurities]);

  const filteredPositions = selectedAccount
    ? positions.filter(p => p.accountId === selectedAccount)
    : positions;

  const securityMap = new Map(securities.map(s => [s.id, s]));
  const accountMap = new Map(accounts.map(a => [a.id, a]));

  const handleOpenModal = (position?: Position) => {
    if (position) {
      const security = securityMap.get(position.securityId);
      setEditingPosition(position);
      setFormData({
        accountId: position.accountId,
        symbol: security?.symbol || '',
        name: security?.name || '',
        type: security?.type || 'stock',
        quantity: position.quantity.toString(),
        costBasis: position.costBasis.toString(),
        currentPrice: position.currentPrice?.toString() || '',
      });
    } else {
      setEditingPosition(null);
      setFormData({
        accountId: accounts[0]?.id || '',
        symbol: '',
        name: '',
        type: 'stock',
        quantity: '',
        costBasis: '',
        currentPrice: '',
      });
    }
    setShowModal(true);
  };

  const handleAddCash = () => {
    setEditingPosition(null);
    setFormData({
      accountId: accounts[0]?.id || '',
      symbol: 'USD',
      name: 'US Dollar',
      type: 'cash',
      quantity: '',
      costBasis: '',
      currentPrice: '1',
    });
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditingPosition(null);
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
          type: formData.type,
          currency: 'USD',
        });
      }

      const quantity = parseFloat(formData.quantity);
      const costBasis = parseFloat(formData.costBasis);

      // For cash positions, always use price of 1
      const isCash = formData.type === 'cash';
      const currentPrice = isCash ? 1 : (formData.currentPrice ? parseFloat(formData.currentPrice) : undefined);
      const marketValue = isCash ? quantity : (currentPrice ? quantity * currentPrice : undefined);
      const unrealizedGain = marketValue !== undefined ? marketValue - costBasis : undefined;
      const unrealizedGainPercent = unrealizedGain !== undefined && costBasis > 0 ? (unrealizedGain / costBasis) * 100 : undefined;

      if (editingPosition) {
        await updatePosition(editingPosition.id, {
          quantity,
          costBasis,
          currentPrice,
          marketValue,
          unrealizedGain,
          unrealizedGainPercent,
        });
      } else {
        await createPosition({
          accountId: formData.accountId,
          securityId: security.id,
          quantity,
          costBasis,
          currentPrice,
          marketValue,
          unrealizedGain,
          unrealizedGainPercent,
          lastUpdated: new Date().toISOString(),
        });
      }
      handleCloseModal();
      fetchSecurities();
    } catch (err) {
      console.error('Failed to save position:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('Are you sure you want to delete this position?')) {
      try {
        await deletePosition(id);
      } catch (err) {
        console.error('Failed to delete position:', err);
      }
    }
  };

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
        <h1 className="text-2xl font-bold text-gray-900">Holdings</h1>
        <div className="flex gap-3">
          <select
            className="select w-48"
            value={selectedAccount}
            onChange={(e) => setSelectedAccount(e.target.value)}
          >
            <option value="">All Accounts</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
          <button onClick={() => setShowImportModal(true)} className="btn-secondary">
            Import from Brokerage
          </button>
          <button onClick={handleAddCash} className="btn-secondary">
            Add Cash
          </button>
          <button onClick={() => handleOpenModal()} className="btn-primary">
            Add Position
          </button>
        </div>
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
      ) : filteredPositions.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-500">No holdings yet.</p>
          <p className="text-sm text-gray-400 mt-1">Add positions manually or import from Excel.</p>
        </div>
      ) : (
        <div className="card overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="table-header">Symbol</th>
                  <th className="table-header">Name</th>
                  <th className="table-header">Account</th>
                  <th className="table-header">Type</th>
                  <th className="table-header text-right">Quantity</th>
                  <th className="table-header text-right">Cost Basis</th>
                  <th className="table-header text-right">Current Price</th>
                  <th className="table-header text-right">Market Value</th>
                  <th className="table-header text-right">Gain/Loss</th>
                  <th className="table-header text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredPositions.map((position) => {
                  const security = securityMap.get(position.securityId);
                  const account = accountMap.get(position.accountId);
                  return (
                    <tr key={position.id} className="hover:bg-gray-50">
                      <td className="table-cell font-medium">{security?.symbol || 'Unknown'}</td>
                      <td className="table-cell text-gray-500 max-w-xs truncate">{security?.name || '-'}</td>
                      <td className="table-cell text-gray-500">{account?.name || 'Unknown'}</td>
                      <td className="table-cell">
                        <span className="badge badge-info capitalize">{security?.type || '-'}</span>
                      </td>
                      <td className="table-cell text-right">{position.quantity.toLocaleString()}</td>
                      <td className="table-cell text-right">{formatCurrency(position.costBasis)}</td>
                      <td className="table-cell text-right">
                        {position.currentPrice ? formatCurrency(position.currentPrice) : '-'}
                      </td>
                      <td className="table-cell text-right">
                        {position.marketValue ? formatCurrency(position.marketValue) : '-'}
                      </td>
                      <td className="table-cell text-right">
                        {position.unrealizedGain !== undefined ? (
                          <div className={position.unrealizedGain >= 0 ? 'positive' : 'negative'}>
                            <div>{formatCurrency(position.unrealizedGain)}</div>
                            <div className="text-xs">
                              {formatPercent(position.unrealizedGainPercent || 0)}
                            </div>
                          </div>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td className="table-cell text-right">
                        <button
                          onClick={() => handleOpenModal(position)}
                          className="text-primary-600 hover:text-primary-700 mr-3"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(position.id)}
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

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">
              {editingPosition ? 'Edit Position' : 'Add Position'}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="label">Account</label>
                <select
                  className="select"
                  value={formData.accountId}
                  onChange={(e) => setFormData({ ...formData, accountId: e.target.value })}
                  required
                  disabled={!!editingPosition}
                >
                  <option value="">Select Account</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </div>
              {formData.type === 'cash' ? (
                <div className="bg-gray-50 p-3 rounded-lg">
                  <div className="text-sm text-gray-600">Adding cash position</div>
                  <div className="font-medium">USD - US Dollar</div>
                </div>
              ) : (
                <>
                  <div>
                    <label className="label">Symbol</label>
                    <input
                      type="text"
                      className="input"
                      value={formData.symbol}
                      onChange={(e) => setFormData({ ...formData, symbol: e.target.value.toUpperCase() })}
                      placeholder="e.g., AAPL"
                      required
                      disabled={!!editingPosition}
                    />
                  </div>
                  {!editingPosition && (
                    <>
                      <div>
                        <label className="label">Name (optional)</label>
                        <input
                          type="text"
                          className="input"
                          value={formData.name}
                          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                          placeholder="e.g., Apple Inc."
                        />
                      </div>
                      <div>
                        <label className="label">Type</label>
                        <select
                          className="select"
                          value={formData.type}
                          onChange={(e) => setFormData({ ...formData, type: e.target.value as Security['type'] })}
                        >
                          <option value="stock">Stock</option>
                          <option value="etf">ETF</option>
                          <option value="mutual_fund">Mutual Fund</option>
                          <option value="bond">Bond</option>
                          <option value="option">Option</option>
                          <option value="crypto">Crypto</option>
                          <option value="cash">Cash</option>
                          <option value="other">Other</option>
                        </select>
                      </div>
                    </>
                  )}
                </>
              )}
              {formData.type === 'cash' ? (
                <div>
                  <label className="label">Amount ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    value={formData.quantity}
                    onChange={(e) => setFormData({
                      ...formData,
                      quantity: e.target.value,
                      costBasis: e.target.value
                    })}
                    placeholder="e.g., 10000.00"
                    required
                  />
                </div>
              ) : (
                <>
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
                      <label className="label">Cost Basis ($)</label>
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
                  <div>
                    <label className="label">Current Price ($ per share, optional)</label>
                    <input
                      type="number"
                      step="0.01"
                      className="input"
                      value={formData.currentPrice}
                      onChange={(e) => setFormData({ ...formData, currentPrice: e.target.value })}
                      placeholder="Leave blank if unknown"
                    />
                  </div>
                </>
              )}
              <div className="flex justify-end gap-3 pt-4">
                <button type="button" onClick={handleCloseModal} className="btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  {editingPosition ? 'Save Changes' : 'Add Position'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Brokerage Import Modal */}
      <BrokerageImportModal
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onSuccess={() => {
          fetchPositions();
          fetchSecurities();
        }}
      />
    </div>
  );
}
