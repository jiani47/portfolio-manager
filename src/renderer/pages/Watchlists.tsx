import { useEffect, useState, useMemo } from 'react';
import { useWatchlists, usePriceLevels } from '../hooks/useApi';
import { useStreamingQuotes } from '../hooks/useStreamingQuotes';
import PriceLevelTooltip from '../components/PriceLevelTooltip';
import ChartModal from '../components/ChartModal';
import type { Watchlist, WatchlistItem, StreamingQuote, PriceLevel } from '../../shared/types';

function renderItemRow(
  item: WatchlistItem,
  streamingQuotes: Map<string, StreamingQuote>,
  formatCurrency: (v: number) => string,
  showRemove: boolean,
  priceLevels: PriceLevel[],
  onRemove?: (id: string) => void,
  onChart?: (symbol: string) => void,
) {
  const quote = streamingQuotes.get(item.symbol);
  const price = quote?.last ?? item.lastPrice;
  const dayChange = quote?.netChange;
  const dayChangePct = quote?.netChangePct;
  const isPositive = (dayChange || 0) >= 0;
  const distance = (price != null && item.targetEntryPrice != null)
    ? ((price - item.targetEntryPrice) / item.targetEntryPrice) * 100
    : null;
  const isNearTarget = distance != null && Math.abs(distance) <= 5;
  return (
    <tr key={item.id} className={`hover:bg-gray-50 ${isNearTarget ? 'bg-green-50' : ''}`}>
      <td className="px-4 py-3 text-sm font-medium text-gray-900 whitespace-nowrap">
        <button
          onClick={() => onChart?.(item.symbol)}
          className="hover:text-blue-600 cursor-pointer"
          title="View chart"
        >
          {item.symbol}
        </button>
      </td>
      <td className="px-4 py-3 text-sm text-gray-700 text-right whitespace-nowrap">
        {price != null ? (
          <PriceLevelTooltip symbol={item.symbol} currentPrice={price} levels={priceLevels}>
            {formatCurrency(price)}
          </PriceLevelTooltip>
        ) : <span className="text-gray-300">--</span>}
      </td>
      <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
        {dayChange != null ? (
          <span className={isPositive ? 'text-green-600' : 'text-red-600'}>
            {isPositive ? '+' : ''}{formatCurrency(dayChange)}
            {dayChangePct != null && (
              <span className="ml-1 text-xs">({isPositive ? '+' : ''}{dayChangePct.toFixed(2)}%)</span>
            )}
          </span>
        ) : <span className="text-gray-300">--</span>}
      </td>
      <td className="px-4 py-3 text-sm text-gray-700 text-right whitespace-nowrap">
        {item.targetEntryPrice != null ? formatCurrency(item.targetEntryPrice) : '--'}
      </td>
      <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
        {distance != null ? (
          <span className={distance <= 0 ? 'text-green-600 font-medium' : distance <= 5 ? 'text-amber-600' : 'text-gray-500'}>
            {distance >= 0 ? '+' : ''}{distance.toFixed(1)}%
          </span>
        ) : '--'}
      </td>
      <td className="px-4 py-3 text-sm text-gray-700 max-w-xs truncate" title={item.thesisSnippet || undefined}>
        {item.thesisSnippet || '--'}
      </td>
      {showRemove && (
        <td className="px-4 py-3 text-right">
          <button
            onClick={() => onRemove?.(item.id)}
            className="text-xs text-gray-400 hover:text-red-500"
            title="Remove item"
          >
            Remove
          </button>
        </td>
      )}
    </tr>
  );
}

export default function Watchlists() {
  const {
    watchlists, items, loading,
    fetchWatchlists, fetchItems,
    createWatchlist, deleteWatchlist,
    addItem, removeItem,
  } = useWatchlists();

  const [selectedId, setSelectedId] = useState<string | null>('__all__');
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');

  // Add item form
  const [addSymbol, setAddSymbol] = useState('');
  const [addTarget, setAddTarget] = useState('');
  const [addThesis, setAddThesis] = useState('');
  const [chartSymbol, setChartSymbol] = useState<string | null>(null);

  // Streaming quotes for watchlist items
  const symbolList = useMemo(() => items.map(i => i.symbol), [items]);
  const { quotes: streamingQuotes } = useStreamingQuotes(symbolList);
  const { levels: priceLevels, fetchLevels } = usePriceLevels();

  useEffect(() => {
    fetchWatchlists();
    fetchLevels();
  }, [fetchWatchlists, fetchLevels]);

  useEffect(() => {
    if (selectedId === '__all__') {
      fetchItems(); // fetch all items across watchlists
    } else if (selectedId) {
      fetchItems(selectedId);
    }
  }, [selectedId, fetchItems]);

  const isAllView = selectedId === '__all__';
  const selectedWatchlist = isAllView ? null : watchlists.find(w => w.id === selectedId);
  const watchlistMap = useMemo(() => new Map(watchlists.map(w => [w.id, w])), [watchlists]);

  // Group items by watchlist for the "All" view
  const groupedItems = useMemo(() => {
    if (!isAllView) return null;
    const groups: { watchlist: Watchlist; items: WatchlistItem[] }[] = [];
    const byWl = new Map<string, WatchlistItem[]>();
    for (const item of items) {
      const arr = byWl.get(item.watchlistId) || [];
      arr.push(item);
      byWl.set(item.watchlistId, arr);
    }
    for (const wl of watchlists) {
      const wlItems = byWl.get(wl.id);
      if (wlItems && wlItems.length > 0) {
        groups.push({ watchlist: wl, items: wlItems });
      }
    }
    return groups;
  }, [isAllView, items, watchlists]);

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

  const handleCreateWatchlist = async () => {
    if (!newName.trim()) return;
    const wl = await createWatchlist(newName.trim(), newDescription.trim() || undefined);
    setSelectedId(wl.id);
    setNewName('');
    setNewDescription('');
    setShowNewForm(false);
  };

  const handleDeleteWatchlist = async (id: string) => {
    if (!confirm('Delete this watchlist and all its items?')) return;
    await deleteWatchlist(id);
    if (selectedId === id) {
      setSelectedId(watchlists.find(w => w.id !== id)?.id || null);
    }
  };

  const handleAddItem = async () => {
    if (!selectedId || !addSymbol.trim()) return;
    await addItem(selectedId, {
      symbol: addSymbol.trim().toUpperCase(),
      targetEntryPrice: addTarget ? parseFloat(addTarget) : undefined,
      thesisSnippet: addThesis.trim() || undefined,
    });
    setAddSymbol('');
    setAddTarget('');
    setAddThesis('');
  };

  const handleRemoveItem = async (id: string) => {
    await removeItem(id);
  };

  const itemCountFor = (wlId: string) => {
    // We only have items for the selected watchlist loaded, so show count only for selected
    if (wlId === selectedId) return items.length;
    return null;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Watchlists</h1>
        <p className="text-sm text-gray-500 mt-1">
          Track symbols you are watching for potential entry.
        </p>
      </div>

      <div className="flex gap-6">
        {/* Left sidebar - watchlist list */}
        <div className="w-64 flex-shrink-0">
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="p-3 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-700">Lists</h2>
              <button
                onClick={() => setShowNewForm(!showNewForm)}
                className="text-xs px-2 py-1 rounded bg-primary-50 text-primary-700 hover:bg-primary-100 font-medium"
              >
                + New
              </button>
            </div>

            {showNewForm && (
              <div className="p-3 border-b border-gray-200 bg-gray-50 space-y-2">
                <input
                  type="text"
                  placeholder="Watchlist name"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                  onKeyDown={e => e.key === 'Enter' && handleCreateWatchlist()}
                />
                <input
                  type="text"
                  placeholder="Description (optional)"
                  value={newDescription}
                  onChange={e => setNewDescription(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleCreateWatchlist}
                    className="text-xs px-3 py-1.5 rounded bg-primary-600 text-white hover:bg-primary-700 font-medium"
                  >
                    Create
                  </button>
                  <button
                    onClick={() => { setShowNewForm(false); setNewName(''); setNewDescription(''); }}
                    className="text-xs px-3 py-1.5 rounded bg-gray-200 text-gray-700 hover:bg-gray-300 font-medium"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {loading && watchlists.length === 0 ? (
              <p className="p-3 text-sm text-gray-500">Loading...</p>
            ) : watchlists.length === 0 ? (
              <p className="p-3 text-sm text-gray-500">No watchlists yet.</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                <li
                  onClick={() => setSelectedId('__all__')}
                  className={`flex items-center justify-between px-3 py-2.5 cursor-pointer text-sm ${
                    isAllView
                      ? 'bg-primary-50 text-primary-700 font-medium'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <span>All</span>
                  {isAllView && items.length > 0 && (
                    <span className="text-xs text-gray-400">{items.length}</span>
                  )}
                </li>
                {watchlists.map(wl => (
                  <li
                    key={wl.id}
                    onClick={() => setSelectedId(wl.id)}
                    className={`flex items-center justify-between px-3 py-2.5 cursor-pointer text-sm ${
                      selectedId === wl.id
                        ? 'bg-primary-50 text-primary-700 font-medium'
                        : 'text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <span className="truncate">{wl.name}</span>
                    <div className="flex items-center gap-2">
                      {itemCountFor(wl.id) !== null && (
                        <span className="text-xs text-gray-400">{itemCountFor(wl.id)}</span>
                      )}
                      <button
                        onClick={e => { e.stopPropagation(); handleDeleteWatchlist(wl.id); }}
                        className="text-gray-400 hover:text-red-500 text-xs"
                        title="Delete watchlist"
                      >
                        x
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Right content - items table */}
        <div className="flex-1 min-w-0">
          {isAllView ? (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900">All Watchlists</h2>
              {groupedItems && groupedItems.length > 0 ? (
                groupedItems.map(group => (
                  <div key={group.watchlist.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                    <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                      <div>
                        <span className="text-sm font-semibold text-gray-800">{group.watchlist.name}</span>
                        {group.watchlist.description && (
                          <span className="ml-2 text-xs text-gray-400">{group.watchlist.description}</span>
                        )}
                      </div>
                      <span className="text-xs text-gray-400">{group.items.length} items</span>
                    </div>
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50/50">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Symbol</th>
                          <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Price</th>
                          <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Day Change</th>
                          <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Target Entry</th>
                          <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Distance</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Thesis</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {group.items.map(item => renderItemRow(item, streamingQuotes, formatCurrency, false, priceLevels, undefined, setChartSymbol))}
                      </tbody>
                    </table>
                  </div>
                ))
              ) : (
                <div className="bg-gray-50 rounded-lg border border-dashed border-gray-300 p-12 text-center">
                  <p className="text-sm text-gray-500">No watchlist items yet.</p>
                </div>
              )}
            </div>
          ) : selectedWatchlist ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">{selectedWatchlist.name}</h2>
                {selectedWatchlist.description && (
                  <p className="text-sm text-gray-500 mt-0.5">{selectedWatchlist.description}</p>
                )}
              </div>

              {/* Add item form */}
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <h3 className="text-sm font-medium text-gray-700 mb-3">Add Symbol</h3>
                <div className="flex gap-3 items-end">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Symbol</label>
                    <input
                      type="text"
                      value={addSymbol}
                      onChange={e => setAddSymbol(e.target.value)}
                      placeholder="AAPL"
                      className="w-24 px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                      onKeyDown={e => e.key === 'Enter' && handleAddItem()}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Target Entry</label>
                    <input
                      type="number"
                      step="0.01"
                      value={addTarget}
                      onChange={e => setAddTarget(e.target.value)}
                      placeholder="0.00"
                      className="w-28 px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="block text-xs text-gray-500 mb-1">Thesis</label>
                    <input
                      type="text"
                      value={addThesis}
                      onChange={e => setAddThesis(e.target.value)}
                      placeholder="Why are you watching this?"
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
                      onKeyDown={e => e.key === 'Enter' && handleAddItem()}
                    />
                  </div>
                  <button
                    onClick={handleAddItem}
                    disabled={!addSymbol.trim()}
                    className="px-4 py-1.5 text-sm rounded bg-primary-600 text-white hover:bg-primary-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Add
                  </button>
                </div>
              </div>

              {/* Items table */}
              <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                {items.length === 0 ? (
                  <p className="p-6 text-sm text-gray-500 text-center">No items in this watchlist yet. Add a symbol above.</p>
                ) : (
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Symbol</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Price</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Day Change</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Target Entry</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Distance</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Thesis</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {items.map(item => renderItemRow(item, streamingQuotes, formatCurrency, true, priceLevels, handleRemoveItem, setChartSymbol))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-gray-50 rounded-lg border border-dashed border-gray-300 p-12 text-center">
              <p className="text-sm text-gray-500">
                {watchlists.length === 0
                  ? 'Create a watchlist to get started.'
                  : 'Select a watchlist from the sidebar.'}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Chart Modal */}
      {chartSymbol && (
        <ChartModal
          symbol={chartSymbol}
          onClose={() => setChartSymbol(null)}
          onLevelsChanged={fetchLevels}
        />
      )}
    </div>
  );
}
