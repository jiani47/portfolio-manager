import { useEffect, useState } from 'react';
import { useMonitors } from '../hooks/useApi';
import type { Monitor } from '../../shared/types';

type FilterType = 'all' | 'price' | 'earnings' | 'fundamental';
type NewMonitorType = 'price' | 'fundamental';

export default function Monitors() {
  const {
    monitors, loading,
    fetchMonitors, createMonitor,
    dismissMonitor, resetMonitor, deleteMonitor,
  } = useMonitors();

  const [showAddForm, setShowAddForm] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [filterType, setFilterType] = useState<FilterType>('all');
  const [newMonitorType, setNewMonitorType] = useState<NewMonitorType>('price');
  const [newSymbol, setNewSymbol] = useState('');
  const [newDirection, setNewDirection] = useState<'above' | 'below'>('above');
  const [newPrice, setNewPrice] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newActionType, setNewActionType] = useState<'informational' | 'action_required'>('informational');
  const [newReminderDate, setNewReminderDate] = useState('');

  useEffect(() => {
    fetchMonitors();
  }, [fetchMonitors]);

  const handleCreate = async () => {
    if (!newSymbol.trim()) return;

    if (newMonitorType === 'price') {
      if (!newPrice) return;
      await createMonitor({
        symbol: newSymbol.trim().toUpperCase(),
        direction: newDirection,
        priceLevel: parseFloat(newPrice),
        label: newLabel.trim() || `${newSymbol.toUpperCase()} ${newDirection} ${newPrice}`,
        actionType: newActionType,
        monitorType: 'price',
      });
    } else {
      // fundamental
      await createMonitor({
        symbol: newSymbol.trim().toUpperCase(),
        direction: 'below',
        priceLevel: 0,
        label: newLabel.trim() || `${newSymbol.toUpperCase()} fundamental monitor`,
        actionType: newActionType,
        monitorType: 'fundamental',
        reminderDate: newReminderDate || undefined,
      });
    }

    setNewSymbol('');
    setNewPrice('');
    setNewLabel('');
    setNewDirection('above');
    setNewActionType('informational');
    setNewMonitorType('price');
    setNewReminderDate('');
    setShowAddForm(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this monitor?')) return;
    await deleteMonitor(id);
  };

  // Sort: triggered first, then active, then dismissed
  const statusOrder: Record<string, number> = { triggered: 0, active: 1, dismissed: 2 };
  const sorted = [...monitors].sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));

  // Apply type filter
  const filtered = filterType === 'all'
    ? sorted
    : sorted.filter(m => (m.monitorType || 'price') === filterType);

  const triggered = filtered.filter(m => m.status === 'triggered');
  const active = filtered.filter(m => m.status === 'active');
  const dismissed = filtered.filter(m => m.status === 'dismissed');

  const renderDirectionIcon = (m: Monitor) => {
    if (m.monitorType && m.monitorType !== 'price') {
      return <span className="text-gray-400">--</span>;
    }
    return (
      <span className={`text-lg ${m.direction === 'above' ? 'text-green-600' : 'text-red-600'}`}>
        {m.direction === 'above' ? '\u2B06' : '\u2B07'}
      </span>
    );
  };

  const renderTypeBadge = (monitorType?: string) => {
    const type = monitorType || 'price';
    const styles: Record<string, string> = {
      price: 'bg-blue-100 text-blue-800',
      earnings: 'bg-purple-100 text-purple-800',
      fundamental: 'bg-orange-100 text-orange-800',
    };
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles[type] || 'bg-gray-100 text-gray-500'}`}>
        {type.charAt(0).toUpperCase() + type.slice(1)}
      </span>
    );
  };

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

  const renderPriceLevel = (m: Monitor) => {
    if (m.priceLevel === 0 || (m.monitorType && m.monitorType !== 'price')) {
      return <span className="text-gray-400">--</span>;
    }
    return <>${m.priceLevel.toFixed(2)}</>;
  };

  const renderTriggeredColumn = (m: Monitor) => {
    if (m.triggeredAt) {
      return new Date(m.triggeredAt).toLocaleString();
    }
    const type = m.monitorType || 'price';
    if (type === 'earnings' && m.expiresAt) {
      return <span className="text-purple-600 text-xs">Expires: {m.expiresAt}</span>;
    }
    if (type === 'fundamental' && m.reminderDate) {
      return <span className="text-orange-600 text-xs">Reminder: {m.reminderDate}</span>;
    }
    return '--';
  };

  const renderRow = (m: Monitor) => {
    const rowBg = m.status === 'triggered' ? 'bg-red-50 hover:bg-red-100' : 'hover:bg-gray-50';
    return (
      <tr key={m.id} className={rowBg}>
        <td className="px-4 py-3 text-sm font-medium text-gray-900 whitespace-nowrap">{m.symbol}</td>
        <td className="px-4 py-3 text-sm text-center">{renderDirectionIcon(m)}</td>
        <td className="px-4 py-3 text-sm text-gray-700 text-right whitespace-nowrap">{renderPriceLevel(m)}</td>
        <td className="px-4 py-3 text-sm text-gray-700 max-w-xs truncate">{m.label}</td>
        <td className="px-4 py-3 text-sm">{renderActionBadge(m.actionType)}</td>
        <td className="px-4 py-3 text-sm">{renderTypeBadge(m.monitorType)}</td>
        <td className="px-4 py-3 text-sm">{renderStatusBadge(m.status)}</td>
        <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">
          {renderTriggeredColumn(m)}
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
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Action</th>
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

  const filterTabs: { label: string; value: FilterType }[] = [
    { label: 'All', value: 'all' },
    { label: 'Price', value: 'price' },
    { label: 'Earnings', value: 'earnings' },
    { label: 'Fundamental', value: 'fundamental' },
  ];

  const isCreateDisabled = newMonitorType === 'price'
    ? !newSymbol.trim() || !newPrice
    : !newSymbol.trim() || !newLabel.trim();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Monitors</h1>
          <p className="text-sm text-gray-500 mt-1">
            Track price levels, earnings dates, and fundamental conditions.
          </p>
        </div>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="px-4 py-2 text-sm rounded-lg bg-primary-600 text-white hover:bg-primary-700 font-medium"
        >
          {showAddForm ? 'Cancel' : '+ Add Monitor'}
        </button>
      </div>

      {/* Type Filter Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
        {filterTabs.map(tab => (
          <button
            key={tab.value}
            onClick={() => setFilterType(tab.value)}
            className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              filterType === tab.value
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Add Monitor Form */}
      {showAddForm && (
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h3 className="text-sm font-medium text-gray-700 mb-3">New Monitor</h3>
          {/* Monitor Type Selector */}
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => setNewMonitorType('price')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md border ${
                newMonitorType === 'price'
                  ? 'bg-blue-50 border-blue-300 text-blue-700'
                  : 'bg-white border-gray-300 text-gray-500 hover:text-gray-700'
              }`}
            >
              Price
            </button>
            <button
              onClick={() => setNewMonitorType('fundamental')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md border ${
                newMonitorType === 'fundamental'
                  ? 'bg-orange-50 border-orange-300 text-orange-700'
                  : 'bg-white border-gray-300 text-gray-500 hover:text-gray-700'
              }`}
            >
              Fundamental
            </button>
            <span className="text-xs text-gray-400 self-center ml-2">
              Earnings monitors are auto-generated
            </span>
          </div>
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
            {newMonitorType === 'price' && (
              <>
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
              </>
            )}
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs text-gray-500 mb-1">
                {newMonitorType === 'price' ? 'Label' : 'Condition'}
              </label>
              <input
                type="text"
                value={newLabel}
                onChange={e => setNewLabel(e.target.value)}
                placeholder={newMonitorType === 'price'
                  ? 'e.g. Support break, Breakout level'
                  : 'e.g. Check margin trends in next 10-Q'
                }
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
              />
            </div>
            {newMonitorType === 'fundamental' && (
              <div>
                <label className="block text-xs text-gray-500 mb-1">Reminder Date</label>
                <input
                  type="date"
                  value={newReminderDate}
                  onChange={e => setNewReminderDate(e.target.value)}
                  className="w-40 px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
            )}
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
              disabled={isCreateDisabled}
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
      ) : filtered.length === 0 ? (
        <div className="bg-gray-50 rounded-lg border border-dashed border-gray-300 p-12 text-center">
          <p className="text-sm text-gray-500">No {filterType} monitors found.</p>
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
