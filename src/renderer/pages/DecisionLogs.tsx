import { useEffect, useState, useMemo } from 'react';
import { useDecisionLogs, useSecurities, useTransactions } from '../hooks/useApi';
import type { DecisionLog, DecisionType, Security, Transaction } from '../../shared/types';
import { format } from 'date-fns';

const DECISION_TYPES: { value: DecisionType; label: string; color: string }[] = [
  { value: 'buy', label: 'Buy', color: 'text-green-700 bg-green-100' },
  { value: 'sell', label: 'Sell', color: 'text-red-700 bg-red-100' },
  { value: 'hold', label: 'Hold', color: 'text-blue-700 bg-blue-100' },
  { value: 'research', label: 'Research', color: 'text-purple-700 bg-purple-100' },
];

// Map legacy/alternate decision types to display values
const DECISION_TYPE_ALIASES: Record<string, { label: string; color: string }> = {
  add: { label: 'Buy', color: 'text-green-700 bg-green-100' },
};

type FormData = {
  securityId: string;
  decisionDate: string;
  decisionType: DecisionType;
  background: string;
  decision: string;
  execution: string;
  transactionIds: string[];
};

const initialFormData: FormData = {
  securityId: '',
  decisionDate: new Date().toISOString().split('T')[0],
  decisionType: 'research',
  background: '',
  decision: '',
  execution: '',
  transactionIds: [],
};

export default function DecisionLogs() {
  const { logs, loading, error, fetchLogs, createLog, updateLog, deleteLog } = useDecisionLogs();
  const { securities, fetchSecurities } = useSecurities();
  const { transactions, fetchTransactions } = useTransactions();
  const [showModal, setShowModal] = useState(false);
  const [editingLog, setEditingLog] = useState<DecisionLog | null>(null);
  const [filterSecurityId, setFilterSecurityId] = useState<string>('');
  const [filterDecisionType, setFilterDecisionType] = useState<DecisionType | ''>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [formData, setFormData] = useState<FormData>(initialFormData);

  useEffect(() => {
    fetchLogs();
    fetchSecurities();
    fetchTransactions();
  }, [fetchLogs, fetchSecurities, fetchTransactions]);

  const securityMap = useMemo(() => new Map(securities.map(s => [s.id, s])), [securities]);
  const transactionMap = useMemo(() => new Map(transactions.map(t => [t.id, t])), [transactions]);

  // Filter securities that are not cash
  const nonCashSecurities = useMemo(() =>
    securities.filter(s => s.type !== 'cash'),
    [securities]
  );

  const filteredLogs = useMemo(() => {
    let filtered = logs;
    if (filterSecurityId) {
      filtered = filtered.filter(l => l.securityId === filterSecurityId);
    }
    if (filterDecisionType) {
      filtered = filtered.filter(l => l.decisionType === filterDecisionType);
    }
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(l =>
        l.decision.toLowerCase().includes(query) ||
        l.background?.toLowerCase().includes(query) ||
        l.execution?.toLowerCase().includes(query)
      );
    }
    return filtered;
  }, [logs, filterSecurityId, filterDecisionType, searchQuery]);

  // Get transactions for the selected security in the form
  const securityTransactions = useMemo(() => {
    if (!formData.securityId) return [];
    return transactions.filter(t => t.securityId === formData.securityId);
  }, [transactions, formData.securityId]);

  const handleOpenModal = (log?: DecisionLog) => {
    if (log) {
      setEditingLog(log);
      setFormData({
        securityId: log.securityId,
        decisionDate: log.decisionDate,
        decisionType: log.decisionType,
        background: log.background || '',
        decision: log.decision,
        execution: log.execution || '',
        transactionIds: log.transactionIds || [],
      });
    } else {
      setEditingLog(null);
      setFormData(initialFormData);
    }
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditingLog(null);
    setFormData(initialFormData);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const logData = {
        securityId: formData.securityId,
        decisionDate: formData.decisionDate,
        decisionType: formData.decisionType,
        background: formData.background || undefined,
        decision: formData.decision,
        execution: formData.execution || undefined,
        transactionIds: formData.transactionIds,
      };

      if (editingLog) {
        await updateLog(editingLog.id, logData);
      } else {
        await createLog(logData);
      }
      handleCloseModal();
    } catch (err) {
      console.error('Failed to save log:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('Are you sure you want to delete this decision log?')) {
      try {
        await deleteLog(id);
      } catch (err) {
        console.error('Failed to delete log:', err);
      }
    }
  };

  const handleTransactionToggle = (transactionId: string) => {
    setFormData(prev => {
      const newIds = prev.transactionIds.includes(transactionId)
        ? prev.transactionIds.filter(id => id !== transactionId)
        : [...prev.transactionIds, transactionId];
      return { ...prev, transactionIds: newIds };
    });
  };

  const getDecisionTypeStyle = (decisionType: string) => {
    const type = DECISION_TYPES.find(t => t.value === decisionType);
    if (type) return type.color;
    const alias = DECISION_TYPE_ALIASES[decisionType];
    return alias?.color || 'text-gray-700 bg-gray-100';
  };

  const getDecisionTypeLabel = (decisionType: string) => {
    const type = DECISION_TYPES.find(t => t.value === decisionType);
    if (type) return type.label;
    const alias = DECISION_TYPE_ALIASES[decisionType];
    return alias?.label || decisionType;
  };

  const formatDate = (dateString: string) => {
    try {
      return format(new Date(dateString), 'MMM d, yyyy');
    } catch {
      return dateString;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Decision Logs</h1>
          <p className="text-sm text-gray-500 mt-1">Track your investment decisions and reasoning</p>
        </div>
        <button onClick={() => handleOpenModal()} className="btn-primary">
          New Entry
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 items-center">
        <select
          className="select w-40"
          value={filterSecurityId}
          onChange={(e) => setFilterSecurityId(e.target.value)}
        >
          <option value="">All Securities</option>
          {nonCashSecurities.map(security => (
            <option key={security.id} value={security.id}>{security.symbol}</option>
          ))}
        </select>
        <select
          className="select w-36"
          value={filterDecisionType}
          onChange={(e) => setFilterDecisionType(e.target.value as DecisionType | '')}
        >
          <option value="">All Types</option>
          {DECISION_TYPES.map(type => (
            <option key={type.value} value={type.value}>{type.label}</option>
          ))}
        </select>
        <input
          type="text"
          className="input w-64"
          placeholder="Search decisions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
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
      ) : filteredLogs.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-500">No decision logs found.</p>
          <p className="text-sm text-gray-400 mt-1">Start documenting your investment decisions.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredLogs.map((log) => {
            const security = securityMap.get(log.securityId);
            const linkedTransactions = log.transactionIds
              ?.map(id => transactionMap.get(id))
              .filter(Boolean) as Transaction[];

            return (
              <div key={log.id} className="card">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <span className={`inline-flex items-center px-2.5 py-1 rounded text-sm font-medium ${getDecisionTypeStyle(log.decisionType)}`}>
                      {getDecisionTypeLabel(log.decisionType)}
                    </span>
                    <span className="font-semibold text-gray-900">
                      {security?.symbol || 'Unknown'}
                    </span>
                    <span className="text-sm text-gray-500">
                      {security?.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-500">
                      {formatDate(log.decisionDate)}
                    </span>
                    <button onClick={() => handleOpenModal(log)} className="text-primary-600 hover:text-primary-700 text-sm">
                      Edit
                    </button>
                    <button onClick={() => handleDelete(log.id)} className="text-red-600 hover:text-red-700 text-sm">
                      Delete
                    </button>
                  </div>
                </div>

                {log.background && (
                  <div className="mb-3">
                    <div className="text-xs font-medium text-gray-500 uppercase mb-1">Background/Research</div>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{log.background}</p>
                  </div>
                )}

                <div className="mb-3">
                  <div className="text-xs font-medium text-gray-500 uppercase mb-1">Decision</div>
                  <p className="text-gray-900 whitespace-pre-wrap">{log.decision}</p>
                </div>

                {log.execution && (
                  <div className="mb-3">
                    <div className="text-xs font-medium text-gray-500 uppercase mb-1">Execution Notes</div>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{log.execution}</p>
                  </div>
                )}

                {linkedTransactions && linkedTransactions.length > 0 && (
                  <div className="pt-3 border-t border-gray-100">
                    <div className="text-xs font-medium text-gray-500 uppercase mb-2">Linked Transactions</div>
                    <div className="flex flex-wrap gap-2">
                      {linkedTransactions.map(txn => (
                        <span key={txn.id} className="inline-flex items-center px-2 py-1 rounded text-xs bg-gray-100 text-gray-700">
                          {txn.type.toUpperCase()} - {formatDate(txn.date)} - ${txn.amount.toFixed(2)}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">
              {editingLog ? 'Edit Decision Log' : 'New Decision Log'}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="label">Security</label>
                  <select
                    className="select"
                    value={formData.securityId}
                    onChange={(e) => setFormData({ ...formData, securityId: e.target.value, transactionIds: [] })}
                    required
                  >
                    <option value="">Select security...</option>
                    {nonCashSecurities.map(security => (
                      <option key={security.id} value={security.id}>{security.symbol} - {security.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Date</label>
                  <input
                    type="date"
                    className="input"
                    value={formData.decisionDate}
                    onChange={(e) => setFormData({ ...formData, decisionDate: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <label className="label">Decision Type</label>
                  <select
                    className="select"
                    value={formData.decisionType}
                    onChange={(e) => setFormData({ ...formData, decisionType: e.target.value as DecisionType })}
                    required
                  >
                    {DECISION_TYPES.map(type => (
                      <option key={type.value} value={type.value}>{type.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="label">Background / Research (optional)</label>
                <textarea
                  className="input"
                  rows={3}
                  value={formData.background}
                  onChange={(e) => setFormData({ ...formData, background: e.target.value })}
                  placeholder="Why are you considering this investment? What's the thesis?"
                />
              </div>

              <div>
                <label className="label">Decision</label>
                <textarea
                  className="input"
                  rows={3}
                  value={formData.decision}
                  onChange={(e) => setFormData({ ...formData, decision: e.target.value })}
                  placeholder="What did you decide to do? Be specific."
                  required
                />
              </div>

              <div>
                <label className="label">Execution Notes (optional)</label>
                <textarea
                  className="input"
                  rows={2}
                  value={formData.execution}
                  onChange={(e) => setFormData({ ...formData, execution: e.target.value })}
                  placeholder="How did you execute? What was the actual outcome?"
                />
              </div>

              {formData.securityId && securityTransactions.length > 0 && (
                <div>
                  <label className="label">Link Transactions (optional)</label>
                  <div className="max-h-40 overflow-y-auto border rounded-lg divide-y">
                    {securityTransactions.map(txn => (
                      <label key={txn.id} className="flex items-center gap-3 p-2 hover:bg-gray-50 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formData.transactionIds.includes(txn.id)}
                          onChange={() => handleTransactionToggle(txn.id)}
                          className="rounded border-gray-300"
                        />
                        <span className="text-sm">
                          <span className="font-medium">{txn.type.toUpperCase()}</span>
                          {' - '}
                          {formatDate(txn.date)}
                          {' - '}
                          {txn.quantity} shares @ ${txn.price.toFixed(2)}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-4">
                <button type="button" onClick={handleCloseModal} className="btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  {editingLog ? 'Save Changes' : 'Create Entry'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
