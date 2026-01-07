import { useEffect, useState } from 'react';
import { useAccounts } from '../hooks/useApi';
import type { Account } from '../../shared/types';

const accountTypes = [
  { value: 'brokerage', label: 'Brokerage' },
  { value: 'ira', label: 'Traditional IRA' },
  { value: 'roth_ira', label: 'Roth IRA' },
  { value: '401k', label: '401(k)' },
  { value: 'other', label: 'Other' },
];

export default function Accounts() {
  const { accounts, loading, error, fetchAccounts, createAccount, updateAccount, deleteAccount } = useAccounts();
  const [showModal, setShowModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    broker: '',
    accountNumber: '',
    accountType: 'brokerage' as Account['accountType'],
    currency: 'USD',
  });

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  const handleOpenModal = (account?: Account) => {
    if (account) {
      setEditingAccount(account);
      setFormData({
        name: account.name,
        broker: account.broker,
        accountNumber: account.accountNumber || '',
        accountType: account.accountType,
        currency: account.currency,
      });
    } else {
      setEditingAccount(null);
      setFormData({
        name: '',
        broker: '',
        accountNumber: '',
        accountType: 'brokerage',
        currency: 'USD',
      });
    }
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditingAccount(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingAccount) {
        await updateAccount(editingAccount.id, formData);
      } else {
        await createAccount(formData);
      }
      handleCloseModal();
    } catch (err) {
      console.error('Failed to save account:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('Are you sure you want to delete this account? This will also delete all associated positions and transactions.')) {
      try {
        await deleteAccount(id);
      } catch (err) {
        console.error('Failed to delete account:', err);
      }
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Accounts</h1>
        <button onClick={() => handleOpenModal()} className="btn-primary">
          Add Account
        </button>
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
      ) : accounts.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-500">No accounts yet.</p>
          <p className="text-sm text-gray-400 mt-1">Add your first brokerage account to get started.</p>
          <button onClick={() => handleOpenModal()} className="btn-primary mt-4">
            Add Your First Account
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {accounts.map((account) => (
            <div key={account.id} className="card hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-gray-900">{account.name}</h3>
                  <p className="text-sm text-gray-500">{account.broker}</p>
                </div>
                <span className="badge badge-info capitalize">
                  {account.accountType.replace('_', ' ')}
                </span>
              </div>
              {account.accountNumber && (
                <p className="text-sm text-gray-400 mt-2">****{account.accountNumber.slice(-4)}</p>
              )}
              <div className="flex gap-2 mt-4 pt-4 border-t border-gray-100">
                <button
                  onClick={() => handleOpenModal(account)}
                  className="text-sm text-primary-600 hover:text-primary-700"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(account.id)}
                  className="text-sm text-red-600 hover:text-red-700"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">
              {editingAccount ? 'Edit Account' : 'Add Account'}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="label">Account Name</label>
                <input
                  type="text"
                  className="input"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g., Main Brokerage"
                  required
                />
              </div>
              <div>
                <label className="label">Broker</label>
                <input
                  type="text"
                  className="input"
                  value={formData.broker}
                  onChange={(e) => setFormData({ ...formData, broker: e.target.value })}
                  placeholder="e.g., Fidelity, Schwab, Vanguard"
                  required
                />
              </div>
              <div>
                <label className="label">Account Number (Optional)</label>
                <input
                  type="text"
                  className="input"
                  value={formData.accountNumber}
                  onChange={(e) => setFormData({ ...formData, accountNumber: e.target.value })}
                  placeholder="For your reference only"
                />
              </div>
              <div>
                <label className="label">Account Type</label>
                <select
                  className="select"
                  value={formData.accountType}
                  onChange={(e) => setFormData({ ...formData, accountType: e.target.value as Account['accountType'] })}
                >
                  {accountTypes.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Currency</label>
                <select
                  className="select"
                  value={formData.currency}
                  onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                >
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                  <option value="GBP">GBP</option>
                  <option value="CAD">CAD</option>
                  <option value="JPY">JPY</option>
                </select>
              </div>
              <div className="flex justify-end gap-3 pt-4">
                <button type="button" onClick={handleCloseModal} className="btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  {editingAccount ? 'Save Changes' : 'Add Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
