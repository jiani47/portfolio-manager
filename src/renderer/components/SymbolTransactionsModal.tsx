import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import type { Transaction } from '../../shared/types';

interface SymbolTransactionsModalProps {
  symbol: string | null;
  onClose: () => void;
}

export default function SymbolTransactionsModal({ symbol, onClose }: SymbolTransactionsModalProps) {
  const [transactions, setTransactions] = useState<Array<Transaction & { accountName?: string }>>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!symbol) return;

    setLoading(true);
    window.electronAPI.getSymbolTransactions(symbol, 20)
      .then(setTransactions)
      .catch((err) => {
        console.error('Failed to fetch symbol transactions:', err);
        setTransactions([]);
      })
      .finally(() => setLoading(false));
  }, [symbol]);

  if (!symbol) return null;

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
        return 'bg-green-100 text-green-800';
      case 'sell':
      case 'transfer_out':
        return 'bg-red-100 text-red-800';
      case 'dividend':
      case 'interest':
        return 'bg-blue-100 text-blue-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">{symbol} Transactions</h2>
            <p className="text-sm text-gray-500 mt-0.5">Last 20 transactions across all accounts</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-gray-500">Loading transactions...</div>
            </div>
          ) : transactions.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-500">No transactions found for {symbol}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Date
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Type
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Account
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Quantity
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Price
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Amount
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Notes
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {transactions.map((txn, idx) => (
                    <tr key={txn.id || idx} className="hover:bg-gray-50">
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                        {format(new Date(txn.date), 'MMM d, yyyy')}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`px-2 py-1 inline-flex text-xs leading-5 font-medium rounded-md ${getTypeColor(txn.type)}`}>
                          {txn.type.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                        {txn.accountName || 'Unknown'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                        {txn.quantity.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                        {formatCurrency(txn.price)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900 font-medium">
                        {formatCurrency(txn.amount)}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 max-w-xs truncate">
                        {txn.notes || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
