import { useEffect, useState, useMemo, useCallback } from 'react';
import { usePositions, useAccounts, useSecurities, useSecurityTags } from '../hooks/useApi';
import BrokerageImportModal from '../components/BrokerageImportModal';
import type { Position, Security, SecurityTag } from '../../shared/types';

interface PositionWithPercent extends Position {
  portfolioPercent: number;
  security?: Security;
  account?: { id: string; name: string };
  tags?: SecurityTag[];
}

const TAG_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  blue: { bg: 'bg-blue-100', text: 'text-blue-800', border: 'border-blue-200' },
  purple: { bg: 'bg-purple-100', text: 'text-purple-800', border: 'border-purple-200' },
  orange: { bg: 'bg-orange-100', text: 'text-orange-800', border: 'border-orange-200' },
  green: { bg: 'bg-green-100', text: 'text-green-800', border: 'border-green-200' },
  red: { bg: 'bg-red-100', text: 'text-red-800', border: 'border-red-200' },
  gray: { bg: 'bg-gray-100', text: 'text-gray-800', border: 'border-gray-200' },
};

export default function Holdings() {
  const { positions, loading, error, fetchPositions, createPosition, updatePosition, deletePosition } = usePositions();
  const { accounts, fetchAccounts } = useAccounts();
  const { securities, fetchSecurities, createSecurity, findBySymbol } = useSecurities();
  const { tags, assignments, fetchTags, fetchAssignments, assignTag, removeTag } = useSecurityTags();
  const [showModal, setShowModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showTagModal, setShowTagModal] = useState(false);
  const [editingPosition, setEditingPosition] = useState<Position | null>(null);
  const [taggingPosition, setTaggingPosition] = useState<PositionWithPercent | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const [selectedTagFilter, setSelectedTagFilter] = useState<string>('');
  const [showWatchlist, setShowWatchlist] = useState(false);
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
    fetchTags();
    fetchAssignments();
  }, [fetchPositions, fetchAccounts, fetchSecurities, fetchTags, fetchAssignments]);

  // Create a map of security ID to tags
  const securityTagsMap = useMemo(() => {
    const map = new Map<string, SecurityTag[]>();
    for (const assignment of assignments) {
      const tag = tags.find(t => t.id === assignment.tagId);
      if (tag) {
        const existing = map.get(assignment.securityId) || [];
        existing.push(tag);
        map.set(assignment.securityId, existing);
      }
    }
    return map;
  }, [tags, assignments]);

  const securityMap = useMemo(() => new Map(securities.map(s => [s.id, s])), [securities]);
  const accountMap = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);

  // Calculate positions with portfolio percentage and group them
  const { concentratedPositions, normalPositions, smallPositions, watchlistPositions, totalMarketValue, totalCash } = useMemo(() => {
    let filtered = selectedAccount
      ? positions.filter(p => p.accountId === selectedAccount)
      : positions;

    // Calculate total market value (including cash for percentage calculation)
    const total = filtered.reduce((sum, p) => sum + (p.marketValue || 0), 0);

    // Add percentage and enrich with security/account info and tags
    let enriched: PositionWithPercent[] = filtered.map(p => ({
      ...p,
      portfolioPercent: total > 0 ? ((p.marketValue || 0) / total) * 100 : 0,
      security: securityMap.get(p.securityId),
      account: accountMap.get(p.accountId),
      tags: securityTagsMap.get(p.securityId) || [],
    }));

    // Apply tag filter if selected
    if (selectedTagFilter) {
      enriched = enriched.filter(p => p.tags?.some(t => t.id === selectedTagFilter));
    }

    // Separate cash positions from non-cash
    const cashPositions = enriched.filter(p => p.security?.type === 'cash');
    const nonCashPositions = enriched.filter(p => p.security?.type !== 'cash');
    const cashTotal = cashPositions.reduce((sum, p) => sum + (p.marketValue || 0), 0);

    // Sort non-cash by percentage descending
    nonCashPositions.sort((a, b) => b.portfolioPercent - a.portfolioPercent);

    // Separate watchlist (<= 1 share) from regular positions
    const watchlist = nonCashPositions.filter(p => p.quantity <= 1);
    const regular = nonCashPositions.filter(p => p.quantity > 1);

    // Group regular positions
    const concentrated = regular.filter(p => p.portfolioPercent >= 5);
    const normal = regular.filter(p => p.portfolioPercent >= 1 && p.portfolioPercent < 5);
    const small = regular.filter(p => p.portfolioPercent < 1);

    return {
      concentratedPositions: concentrated,
      normalPositions: normal,
      smallPositions: small,
      watchlistPositions: watchlist,
      totalMarketValue: total,
      totalCash: cashTotal,
    };
  }, [positions, selectedAccount, selectedTagFilter, securityMap, accountMap, securityTagsMap]);

  const handleOpenTagModal = useCallback((position: PositionWithPercent) => {
    setTaggingPosition(position);
    setShowTagModal(true);
  }, []);

  const handleTagToggle = useCallback(async (tagId: string) => {
    if (!taggingPosition) return;
    const securityId = taggingPosition.securityId;
    const hasTag = taggingPosition.tags?.some(t => t.id === tagId);

    try {
      if (hasTag) {
        await removeTag(securityId, tagId);
      } else {
        await assignTag(securityId, tagId);
      }
      // Refresh assignments
      await fetchAssignments();
    } catch (err) {
      console.error('Failed to toggle tag:', err);
    }
  }, [taggingPosition, assignTag, removeTag, fetchAssignments]);

  const renderTagBadges = (positionTags: SecurityTag[] = []) => {
    if (positionTags.length === 0) return null;
    return (
      <div className="flex gap-1 mt-1">
        {positionTags.map(tag => {
          const colors = TAG_COLORS[tag.color] || TAG_COLORS.gray;
          return (
            <span
              key={tag.id}
              className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${colors.bg} ${colors.text}`}
            >
              {tag.displayName}
            </span>
          );
        })}
      </div>
    );
  };

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
          <select
            className="select w-40"
            value={selectedTagFilter}
            onChange={(e) => setSelectedTagFilter(e.target.value)}
          >
            <option value="">All Tags</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.displayName}
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
      ) : (concentratedPositions.length + normalPositions.length + smallPositions.length) === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-500">No holdings yet.</p>
          <p className="text-sm text-gray-400 mt-1">Add positions manually or import from Excel.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Summary */}
          <div className="card">
            <div className="flex items-baseline gap-6">
              <div>
                <div className="text-sm text-gray-500">Total Portfolio Value</div>
                <div className="text-2xl font-bold text-gray-900">{formatCurrency(totalMarketValue)}</div>
              </div>
              {totalCash > 0 && (
                <div>
                  <div className="text-sm text-gray-500">Cash</div>
                  <div className="text-xl font-semibold text-gray-700">{formatCurrency(totalCash)}</div>
                </div>
              )}
            </div>
          </div>

          {/* Concentrated Positions (>= 5%) */}
          {concentratedPositions.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-3 flex items-center gap-2">
                Concentrated Positions
                <span className="text-sm font-normal text-gray-500">({'\u2265'}5% of portfolio)</span>
              </h2>
              <div className="card overflow-hidden p-0">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="table-header">Symbol</th>
                      <th className="table-header">Name</th>
                      <th className="table-header">Account</th>
                      <th className="table-header text-right">% of Portfolio</th>
                      <th className="table-header text-right">Quantity</th>
                      <th className="table-header text-right">Market Value</th>
                      <th className="table-header text-right">Gain/Loss</th>
                      <th className="table-header text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {concentratedPositions.map((position) => (
                      <tr
                        key={position.id}
                        className={`hover:bg-gray-50 ${position.portfolioPercent >= 8 ? 'bg-amber-50' : ''}`}
                      >
                        <td className="table-cell font-medium">
                          <div className="flex items-center gap-2">
                            {position.security?.symbol || 'Unknown'}
                            {position.portfolioPercent >= 8 && (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-amber-200 text-amber-800">
                                {'\u2265'}8%
                              </span>
                            )}
                          </div>
                          {renderTagBadges(position.tags)}
                        </td>
                        <td className="table-cell text-gray-500 max-w-xs truncate">{position.security?.name || '-'}</td>
                        <td className="table-cell text-gray-500">{position.account?.name || 'Unknown'}</td>
                        <td className="table-cell text-right font-semibold">
                          <span className={position.portfolioPercent >= 8 ? 'text-amber-700' : ''}>
                            {position.portfolioPercent.toFixed(1)}%
                          </span>
                        </td>
                        <td className="table-cell text-right">{position.quantity.toLocaleString()}</td>
                        <td className="table-cell text-right">{position.marketValue ? formatCurrency(position.marketValue) : '-'}</td>
                        <td className="table-cell text-right">
                          {position.unrealizedGain !== undefined ? (
                            <div className={position.unrealizedGain >= 0 ? 'positive' : 'negative'}>
                              <div>{formatCurrency(position.unrealizedGain)}</div>
                              <div className="text-xs">{formatPercent(position.unrealizedGainPercent || 0)}</div>
                            </div>
                          ) : '-'}
                        </td>
                        <td className="table-cell text-right">
                          <button onClick={() => handleOpenTagModal(position)} className="text-purple-600 hover:text-purple-700 mr-3">Tag</button>
                          <button onClick={() => handleOpenModal(position)} className="text-primary-600 hover:text-primary-700 mr-3">Edit</button>
                          <button onClick={() => handleDelete(position.id)} className="text-red-600 hover:text-red-700">Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Normal Positions (1% to <5%) */}
          {normalPositions.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-3 flex items-center gap-2">
                Standard Positions
                <span className="text-sm font-normal text-gray-500">(1% - 5% of portfolio)</span>
              </h2>
              <div className="card overflow-hidden p-0">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="table-header">Symbol</th>
                      <th className="table-header">Name</th>
                      <th className="table-header">Account</th>
                      <th className="table-header text-right">% of Portfolio</th>
                      <th className="table-header text-right">Quantity</th>
                      <th className="table-header text-right">Market Value</th>
                      <th className="table-header text-right">Gain/Loss</th>
                      <th className="table-header text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {normalPositions.map((position) => (
                      <tr key={position.id} className="hover:bg-gray-50">
                        <td className="table-cell font-medium">
                          {position.security?.symbol || 'Unknown'}
                          {renderTagBadges(position.tags)}
                        </td>
                        <td className="table-cell text-gray-500 max-w-xs truncate">{position.security?.name || '-'}</td>
                        <td className="table-cell text-gray-500">{position.account?.name || 'Unknown'}</td>
                        <td className="table-cell text-right font-medium">{position.portfolioPercent.toFixed(1)}%</td>
                        <td className="table-cell text-right">{position.quantity.toLocaleString()}</td>
                        <td className="table-cell text-right">{position.marketValue ? formatCurrency(position.marketValue) : '-'}</td>
                        <td className="table-cell text-right">
                          {position.unrealizedGain !== undefined ? (
                            <div className={position.unrealizedGain >= 0 ? 'positive' : 'negative'}>
                              <div>{formatCurrency(position.unrealizedGain)}</div>
                              <div className="text-xs">{formatPercent(position.unrealizedGainPercent || 0)}</div>
                            </div>
                          ) : '-'}
                        </td>
                        <td className="table-cell text-right">
                          <button onClick={() => handleOpenTagModal(position)} className="text-purple-600 hover:text-purple-700 mr-3">Tag</button>
                          <button onClick={() => handleOpenModal(position)} className="text-primary-600 hover:text-primary-700 mr-3">Edit</button>
                          <button onClick={() => handleDelete(position.id)} className="text-red-600 hover:text-red-700">Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Small Positions (<1%) */}
          {smallPositions.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-3 flex items-center gap-2">
                Small Positions
                <span className="text-sm font-normal text-gray-500">({'<'}1% of portfolio)</span>
              </h2>
              <div className="card overflow-hidden p-0">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="table-header">Symbol</th>
                      <th className="table-header">Name</th>
                      <th className="table-header">Account</th>
                      <th className="table-header text-right">% of Portfolio</th>
                      <th className="table-header text-right">Quantity</th>
                      <th className="table-header text-right">Market Value</th>
                      <th className="table-header text-right">Gain/Loss</th>
                      <th className="table-header text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {smallPositions.map((position) => (
                      <tr key={position.id} className="hover:bg-gray-50">
                        <td className="table-cell font-medium">
                          {position.security?.symbol || 'Unknown'}
                          {renderTagBadges(position.tags)}
                        </td>
                        <td className="table-cell text-gray-500 max-w-xs truncate">{position.security?.name || '-'}</td>
                        <td className="table-cell text-gray-500">{position.account?.name || 'Unknown'}</td>
                        <td className="table-cell text-right text-gray-500">{position.portfolioPercent.toFixed(2)}%</td>
                        <td className="table-cell text-right">{position.quantity.toLocaleString()}</td>
                        <td className="table-cell text-right">{position.marketValue ? formatCurrency(position.marketValue) : '-'}</td>
                        <td className="table-cell text-right">
                          {position.unrealizedGain !== undefined ? (
                            <div className={position.unrealizedGain >= 0 ? 'positive' : 'negative'}>
                              <div>{formatCurrency(position.unrealizedGain)}</div>
                              <div className="text-xs">{formatPercent(position.unrealizedGainPercent || 0)}</div>
                            </div>
                          ) : '-'}
                        </td>
                        <td className="table-cell text-right">
                          <button onClick={() => handleOpenTagModal(position)} className="text-purple-600 hover:text-purple-700 mr-3">Tag</button>
                          <button onClick={() => handleOpenModal(position)} className="text-primary-600 hover:text-primary-700 mr-3">Edit</button>
                          <button onClick={() => handleDelete(position.id)} className="text-red-600 hover:text-red-700">Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Watchlist (< 1 share) - Collapsible */}
          {watchlistPositions.length > 0 && (
            <div>
              <button
                onClick={() => setShowWatchlist(!showWatchlist)}
                className="w-full flex items-center justify-between text-lg font-semibold text-gray-900 mb-3 hover:text-gray-700"
              >
                <div className="flex items-center gap-2">
                  <span className="text-gray-400">{showWatchlist ? '▼' : '▶'}</span>
                  Watchlist
                  <span className="text-sm font-normal text-gray-500">({'\u2264'}1 share, {watchlistPositions.length} positions)</span>
                </div>
              </button>
              {showWatchlist && (
                <div className="card overflow-hidden p-0">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="table-header">Symbol</th>
                        <th className="table-header">Name</th>
                        <th className="table-header">Account</th>
                        <th className="table-header text-right">Quantity</th>
                        <th className="table-header text-right">Market Value</th>
                        <th className="table-header text-right">Gain/Loss</th>
                        <th className="table-header text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {watchlistPositions.map((position) => (
                        <tr key={position.id} className="hover:bg-gray-50">
                          <td className="table-cell font-medium">
                            {position.security?.symbol || 'Unknown'}
                            {renderTagBadges(position.tags)}
                          </td>
                          <td className="table-cell text-gray-500 max-w-xs truncate">{position.security?.name || '-'}</td>
                          <td className="table-cell text-gray-500">{position.account?.name || 'Unknown'}</td>
                          <td className="table-cell text-right text-gray-500">{position.quantity.toFixed(4)}</td>
                          <td className="table-cell text-right">{position.marketValue ? formatCurrency(position.marketValue) : '-'}</td>
                          <td className="table-cell text-right">
                            {position.unrealizedGain !== undefined ? (
                              <div className={position.unrealizedGain >= 0 ? 'positive' : 'negative'}>
                                <div>{formatCurrency(position.unrealizedGain)}</div>
                                <div className="text-xs">{formatPercent(position.unrealizedGainPercent || 0)}</div>
                              </div>
                            ) : '-'}
                          </td>
                          <td className="table-cell text-right">
                            <button onClick={() => handleOpenTagModal(position)} className="text-purple-600 hover:text-purple-700 mr-3">Tag</button>
                            <button onClick={() => handleOpenModal(position)} className="text-primary-600 hover:text-primary-700 mr-3">Edit</button>
                            <button onClick={() => handleDelete(position.id)} className="text-red-600 hover:text-red-700">Delete</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
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

      {/* Tag Modal */}
      {showTagModal && taggingPosition && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">
              Manage Tags
            </h2>
            <p className="text-sm text-gray-500 mb-4">
              {taggingPosition.security?.symbol} - {taggingPosition.security?.name}
            </p>
            <div className="space-y-2 mb-6">
              {tags.map(tag => {
                const colors = TAG_COLORS[tag.color] || TAG_COLORS.gray;
                const isSelected = taggingPosition.tags?.some(t => t.id === tag.id);
                return (
                  <label
                    key={tag.id}
                    className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      isSelected
                        ? `${colors.bg} ${colors.border} border-2`
                        : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => handleTagToggle(tag.id)}
                      className="rounded border-gray-300"
                    />
                    <div>
                      <div className={`font-medium ${isSelected ? colors.text : 'text-gray-900'}`}>
                        {tag.displayName}
                      </div>
                      {tag.description && (
                        <div className="text-xs text-gray-500">{tag.description}</div>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => {
                  setShowTagModal(false);
                  setTaggingPosition(null);
                }}
                className="btn-secondary"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
