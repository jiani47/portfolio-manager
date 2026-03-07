import { useEffect, useState } from 'react';
import { useMonitors } from '../hooks/useApi';
import type { Monitor } from '../../shared/types';

export default function Monitors() {
  const {
    monitors, loading,
    fetchMonitors, createMonitor,
    dismissMonitor, resetMonitor, deleteMonitor,
  } = useMonitors();

  const [showAddForm, setShowAddForm] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [newSymbol, setNewSymbol] = useState('');
  const [newDirection, setNewDirection] = useState<'above' | 'below'>('above');
  const [newPrice, setNewPrice] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newActionType, setNewActionType] = useState<'informational' | 'action_required'>('informational');

  useEffect(() => {
    fetchMonitors();
  }, [fetchMonitors]);

  const handleCreate = async () => {
    if (!newSymbol.trim() || !newPrice) return;
    await createMonitor({
      symbol: newSymbol.trim().toUpperCase(),
      direction: newDirection,
      priceLevel: parseFloat(newPrice),
      label: newLabel.trim() || `${newSymbol.toUpperCase()} ${newDirection} ${newPrice}`,
      actionType: newActionType,
    });
    setNewSymbol('');
    setNewPrice('');
    setNewLabel('');
    setNewDirection('above');
    setNewActionType('informational');
    setShowAddForm(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this monitor?')) return;
    await deleteMonitor(id);
  };

  // Sort: triggered first, then active, then dismissed
  const statusOrder: Record<string, number> = { triggered: 0, active: 1, dismissed: 2 };
  const sorted = [...monitors].sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));

  const triggered = sorted.filter(m => m.status === 'triggered');
  const active = sorted.filter(m => m.status === 'active');
  const dismissed = sorted.filter(m => m.status === 'dismissed');

  const renderDirectionIcon = (direction: string) => (
    <span className={`text-lg ${direction === 'above' ? 'text-green-600' : 'text-red-600'}`}>
      {direction === 'above' ? '\u2B06' : '\u2B07'}
    </span>
  );

  const renderActionBadge = (actionType: string) => (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
      actionType === 'action_required'
        ? 'bg-yellow-100 text-yellow-800'
        : 'bg-gray-100 text-gray-600'
    }`}>
      {actionType === 'action_required' ? 'Action Required' : 'Informational'}
    </span>
  );

  const renderStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      triggered: 'bg-red-100 text-red-800',
      active: 'bg-green-100 text-green-800',
      dismissed: 'bg-gray-100 text-gray-500',
    };
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] || 'bg-gray-100 text-gray-500'}`}>
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </span>
    );
  };

  const renderRow = (m: Monitor) => {
    const rowBg = m.status === 'triggered' ? 'bg-red-50 hover:bg-red-100' : 'hover:bg-gray-50';
    return (
      <tr key={m.id} className={rowBg}>
        <td className="px-4 py-3 text-sm font-medium text-gray-900 whitespace-nowrap">{m.symbol}</td>
        <td className="px-4 py-3 text-sm text-center">{renderDirectionIcon(m.direction)}</td>
        <td className="px-4 py-3 text-sm text-gray-700 text-right whitespace-nowrap">${m.priceLevel.toFixed(2)}</td>
        <td className="px-4 py-3 text-sm text-gray-700 max-w-xs truncate">{m.label}</td>
        <td className="px-4 py-3 text-sm">{renderActionBadge(m.actionType)}</td>
        <td className="px-4 py-3 text-sm">{renderStatusBadge(m.status)}</td>
        <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">
          {m.triggeredAt ? new Date(m.triggeredAt).toLocaleString() : '--'}
        </td>
        <td className="px-4 py-3 text-right whitespace-nowrap">
          <div className="flex items-center justify-end gap-2">
            {m.status === 'triggered' && (
              <button
                onClick={() => dismissMonitor(m.id)}
                className="text-xs px-2 py-1 rounded bg-gray-200 text-gray-700 hover:bg-gray-300 font-medium"
              >
                Dismiss
              </button>
            )}
            {(m.status === 'triggered' || m.status === 'dismissed') && (
              <button
                onClick={() => resetMonitor(m.id)}
                className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-700 hover:bg-blue-200 font-medium"
              >
                Reset
              </button>
            )}
            <button
              onClick={() => handleDelete(m.id)}
              className="text-xs text-gray-400 hover:text-red-500"
              title="Delete monitor"
            >
              Delete
            </button>
          </div>
        </td>
      </tr>
    );
  };

  const renderTable = (rows: Monitor[], title?: string) => {
    if (rows.length === 0) return null;
    return (
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        {title && (
          <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-gray-700">{title} ({rows.length})</h3>
          </div>
        )}
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Symbol</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Dir</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Price Level</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Label</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Triggered</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {rows.map(renderRow)}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Price Monitors</h1>
          <p className="text-sm text-gray-500 mt-1">
            Set price level alerts for symbols you are tracking.
          </p>
        </div>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="px-4 py-2 text-sm rounded-lg bg-primary-600 text-white hover:bg-primary-700 font-medium"
        >
          {showAddForm ? 'Cancel' : '+ Add Monitor'}
        </button>
      </div>

      {/* Add Monitor Form */}
      {showAddForm && (
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h3 className="text-sm font-medium text-gray-700 mb-3">New Monitor</h3>
          <div className="flex gap-3 items-end flex-wrap">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Symbol</label>
              <input
                type="text"
                value={newSymbol}
                onChange={e => setNewSymbol(e.target.value)}
                placeholder="AAPL"
                className="w-24 px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Direction</label>
              <select
                value={newDirection}
                onChange={e => setNewDirection(e.target.value as 'above' | 'below')}
                className="w-28 px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="above">Above</option>
                <option value="below">Below</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Price Level</label>
              <input
                type="number"
                step="0.01"
                value={newPrice}
                onChange={e => setNewPrice(e.target.value)}
                placeholder="0.00"
                className="w-28 px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
              />
            </div>
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs text-gray-500 mb-1">Label</label>
              <input
                type="text"
                value={newLabel}
                onChange={e => setNewLabel(e.target.value)}
                placeholder="e.g. Support break, Breakout level"
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Action Type</label>
              <select
                value={newActionType}
                onChange={e => setNewActionType(e.target.value as 'informational' | 'action_required')}
                className="w-40 px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="informational">Informational</option>
                <option value="action_required">Action Required</option>
              </select>
            </div>
            <button
              onClick={handleCreate}
              disabled={!newSymbol.trim() || !newPrice}
              className="px-4 py-1.5 text-sm rounded bg-primary-600 text-white hover:bg-primary-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Create
            </button>
          </div>
        </div>
      )}

      {loading && monitors.length === 0 ? (
        <p className="text-sm text-gray-500">Loading monitors...</p>
      ) : monitors.length === 0 ? (
        <div className="bg-gray-50 rounded-lg border border-dashed border-gray-300 p-12 text-center">
          <p className="text-sm text-gray-500">No monitors yet. Add one to start tracking price levels.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {renderTable(triggered, 'Triggered')}
          {renderTable(active, 'Active')}
          {dismissed.length > 0 && (
            <div>
              <button
                onClick={() => setShowDismissed(!showDismissed)}
                className="text-sm text-gray-500 hover:text-gray-700 font-medium mb-2"
              >
                {showDismissed ? 'Hide' : 'Show'} Dismissed ({dismissed.length})
              </button>
              {showDismissed && renderTable(dismissed)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
