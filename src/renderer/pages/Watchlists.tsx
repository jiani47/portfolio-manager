import { useEffect, useState } from 'react';
import { useWatchlists } from '../hooks/useApi';
import type { Watchlist, WatchlistItem } from '../../shared/types';

export default function Watchlists() {
  const {
    watchlists, items, loading,
    fetchWatchlists, fetchItems,
    createWatchlist, deleteWatchlist,
    addItem, removeItem,
  } = useWatchlists();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');

  // Add item form
  const [addSymbol, setAddSymbol] = useState('');
  const [addTarget, setAddTarget] = useState('');
  const [addThesis, setAddThesis] = useState('');

  useEffect(() => {
    fetchWatchlists();
  }, [fetchWatchlists]);

  useEffect(() => {
    if (selectedId) {
      fetchItems(selectedId);
    }
  }, [selectedId, fetchItems]);

  // Auto-select first watchlist
  useEffect(() => {
    if (!selectedId && watchlists.length > 0) {
      setSelectedId(watchlists[0].id);
    }
  }, [watchlists, selectedId]);

  const selectedWatchlist = watchlists.find(w => w.id === selectedId);

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
          {selectedWatchlist ? (
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
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Target Entry</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Thesis</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Notes</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Added</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {items.map(item => (
                        <tr key={item.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm font-medium text-gray-900 whitespace-nowrap">
                            {item.symbol}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-700 text-right whitespace-nowrap">
                            {item.targetEntryPrice != null ? `$${item.targetEntryPrice.toFixed(2)}` : '--'}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-700 max-w-xs truncate">
                            {item.thesisSnippet || '--'}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500 max-w-xs truncate">
                            {item.notes || '--'}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">
                            {item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '--'}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() => handleRemoveItem(item.id)}
                              className="text-xs text-gray-400 hover:text-red-500"
                              title="Remove item"
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
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
    </div>
  );
}
