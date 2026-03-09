import { useEffect, useState, useMemo, useCallback } from 'react';
import { usePositions, useAccounts, useSecurities, useSecurityTags, useSettings, usePositionIntents, useDataProvider } from '../hooks/useApi';
import { useStreamingQuotes } from '../hooks/useStreamingQuotes';
import BrokerageImportModal from '../components/BrokerageImportModal';
import type { Position, Security, SecurityTag, PositionIntent, Account } from '../../shared/types';

interface PositionWithPercent extends Position {
  portfolioPercent: number;
  security?: Security;
  account?: Account;
  tags?: SecurityTag[];
  intent?: PositionIntent;
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
  const { delayed } = useDataProvider();
  const { intents, fetchIntents, upsertIntent } = usePositionIntents();
  const { settings, fetchSettings } = useSettings();
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showTagModal, setShowTagModal] = useState(false);
  const [showIntentModal, setShowIntentModal] = useState(false);
  const [intentPosition, setIntentPosition] = useState<PositionWithPercent | null>(null);
  const [intentForm, setIntentForm] = useState({ tier: '', thesis: '', invalidation: '', entryStyle: '', targetHoldPeriod: '' });
  const [showRiskShape, setShowRiskShape] = useState(false);
  const [editingPosition, setEditingPosition] = useState<Position | null>(null);
  const [taggingPosition, setTaggingPosition] = useState<PositionWithPercent | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const [selectedTagFilter, setSelectedTagFilter] = useState<string>('');
  const [showWatchlist, setShowWatchlist] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
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
    fetchSettings();
    fetchIntents();
  }, [fetchPositions, fetchAccounts, fetchSecurities, fetchTags, fetchAssignments, fetchSettings, fetchIntents]);

  // Listen for position sync events
  useEffect(() => {
    const removeListener = window.electronAPI.onPositionsSynced(() => {
      setLastSynced(new Date());
      fetchPositions();
    });
    return () => removeListener();
  }, [fetchPositions]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!openMenuId) return;
    const handler = () => setOpenMenuId(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [openMenuId]);

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

  // Streaming quotes
  const symbolList = useMemo(() => {
    return positions
      .map(p => securityMap.get(p.securityId))
      .filter(s => s && s.type !== 'cash' && s.type !== 'option')
      .map(s => s!.symbol);
  }, [positions, securityMap]);
  const { quotes: streamingQuotes, status: streamStatus } = useStreamingQuotes(symbolList);

  // Calculate positions with portfolio percentage and group them
  const { concentratedPositions, normalPositions, smallPositions, watchlistPositions, totalMarketValue, totalCash } = useMemo(() => {
    let filtered = selectedAccount
      ? positions.filter(p => p.accountId === selectedAccount)
      : positions;

    // Overlay streaming prices if available
    const withStreaming = filtered.map(p => {
      const security = securityMap.get(p.securityId);
      const streamQuote = security ? streamingQuotes.get(security.symbol) : undefined;
      if (streamQuote && streamQuote.last > 0) {
        const marketValue = p.quantity * streamQuote.last;
        const unrealizedGain = marketValue - p.costBasis;
        return {
          ...p,
          currentPrice: streamQuote.last,
          marketValue,
          unrealizedGain,
          unrealizedGainPercent: p.costBasis > 0 ? (unrealizedGain / p.costBasis) * 100 : 0,
        };
      }
      return p;
    });

    // Calculate total market value (including cash for percentage calculation)
    const total = withStreaming.reduce((sum, p) => sum + (p.marketValue || 0), 0);

    // Add percentage and enrich with security/account info, tags, and intents
    let enriched: PositionWithPercent[] = withStreaming.map(p => ({
      ...p,
      portfolioPercent: total > 0 ? ((p.marketValue || 0) / total) * 100 : 0,
      security: securityMap.get(p.securityId),
      account: accountMap.get(p.accountId),
      tags: securityTagsMap.get(p.securityId) || [],
      intent: intents.get(p.id),
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
  }, [positions, selectedAccount, selectedTagFilter, securityMap, accountMap, securityTagsMap, streamingQuotes, intents]);

  const handleOpenTagModal = useCallback((position: PositionWithPercent) => {
    setTaggingPosition(position);
    setShowTagModal(true);
  }, []);

  const handleTagToggle = useCallback(async (tagId: string) => {
    if (!taggingPosition) return;
    const securityId = taggingPosition.securityId;
    const currentTags = securityTagsMap.get(securityId) || [];
    const hasTag = currentTags.some(t => t.id === tagId);

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
  }, [taggingPosition, securityTagsMap, assignTag, removeTag, fetchAssignments]);

  const handleOpenIntentModal = useCallback((position: PositionWithPercent) => {
    setIntentPosition(position);
    const existing = position.intent;
    setIntentForm({
      tier: existing?.tier || '',
      thesis: existing?.thesis || '',
      invalidation: existing?.invalidation || '',
      entryStyle: existing?.entryStyle || '',
      targetHoldPeriod: existing?.targetHoldPeriod || '',
    });
    setShowIntentModal(true);
  }, []);

  const handleSaveIntent = useCallback(async () => {
    if (!intentPosition) return;
    await upsertIntent(intentPosition.id, intentForm);
    setShowIntentModal(false);
    setIntentPosition(null);
  }, [intentPosition, intentForm, upsertIntent]);

  // Collect existing tier values for autocomplete suggestions
  const existingTiers = useMemo(() => {
    const tiers = new Set<string>();
    for (const [, intent] of intents) {
      if (intent.tier) tiers.add(intent.tier);
    }
    return Array.from(tiers).sort();
  }, [intents]);

  // Risk shape data
  const riskShapeData = useMemo(() => {
    const allPositions = [...concentratedPositions, ...normalPositions, ...smallPositions, ...watchlistPositions];

    // Book split
    const bookSplit = { investing: 0, trading: 0, unassigned: 0 };
    for (const p of allPositions) {
      const book = p.account?.book;
      if (book === 'investing') bookSplit.investing += (p.marketValue || 0);
      else if (book === 'trading') bookSplit.trading += (p.marketValue || 0);
      else bookSplit.unassigned += (p.marketValue || 0);
    }

    // Tier concentration
    const tierMap = new Map<string, number>();
    let noTier = 0;
    for (const p of allPositions) {
      const tier = p.intent?.tier;
      if (tier) {
        tierMap.set(tier, (tierMap.get(tier) || 0) + (p.marketValue || 0));
      } else {
        noTier += (p.marketValue || 0);
      }
    }

    // Sector exposure
    const sectorMap = new Map<string, number>();
    for (const p of allPositions) {
      const sector = p.security?.sector || 'Unknown';
      if (p.security?.type !== 'cash') {
        sectorMap.set(sector, (sectorMap.get(sector) || 0) + (p.marketValue || 0));
      }
    }

    // Account allocation
    const acctMap = new Map<string, number>();
    for (const p of allPositions) {
      const name = p.account?.name || 'Unknown';
      acctMap.set(name, (acctMap.get(name) || 0) + (p.marketValue || 0));
    }

    return { bookSplit, tierMap, noTier, sectorMap, acctMap };
  }, [concentratedPositions, normalPositions, smallPositions, watchlistPositions]);

  const TIER_COLORS: Record<string, { bg: string; text: string }> = {
    'Core': { bg: 'bg-blue-100', text: 'text-blue-800' },
    'Growth': { bg: 'bg-green-100', text: 'text-green-800' },
    'Starter': { bg: 'bg-yellow-100', text: 'text-yellow-800' },
    'Watchlist': { bg: 'bg-orange-100', text: 'text-orange-800' },
  };

  const renderTierBadge = (intent?: PositionIntent) => {
    if (!intent?.tier) return null;
    const colors = TIER_COLORS[intent.tier] || { bg: 'bg-gray-100', text: 'text-gray-800' };
    return (
      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${colors.bg} ${colors.text} ml-1`}>
        {intent.tier}
      </span>
    );
  };

  const renderIntentIcon = (intent?: PositionIntent) => {
    const hasIntent = intent && (intent.tier || intent.thesis);
    return (
      <button
        className={`text-xs ${hasIntent ? 'text-indigo-600 hover:text-indigo-700' : 'text-gray-400 hover:text-gray-600'}`}
        title={hasIntent ? `${intent.tier || 'No tier'}: ${intent.thesis || 'No thesis'}` : 'Set intent'}
      >
        {hasIntent ? '◆' : '◇'}
      </button>
    );
  };

  const renderActionMenu = (position: PositionWithPercent) => {
    const isOpen = openMenuId === position.id;
    return (
      <div className="relative inline-block text-left">
        <button
          onClick={(e) => { e.stopPropagation(); setOpenMenuId(isOpen ? null : position.id); }}
          className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
          </svg>
        </button>
        {isOpen && (
          <div className="absolute right-0 z-10 mt-1 w-36 rounded-md bg-white shadow-lg ring-1 ring-black ring-opacity-5">
            <div className="py-1">
              <button onClick={() => { handleOpenIntentModal(position); setOpenMenuId(null); }} className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">Set Intent</button>
              <button onClick={() => { handleOpenTagModal(position); setOpenMenuId(null); }} className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">Manage Tags</button>
              <button onClick={() => { handleOpenModal(position); setOpenMenuId(null); }} className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">Edit</button>
              <button onClick={() => { handleDelete(position.id); setOpenMenuId(null); }} className="block w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-gray-100">Delete</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderDayChange = (position: PositionWithPercent) => {
    const security = position.security;
    const quote = security ? streamingQuotes.get(security.symbol) : undefined;
    if (!quote?.netChange && !quote?.netChangePct) return null;
    const change = quote.netChange || 0;
    const changePct = quote.netChangePct || 0;
    const isPositive = change >= 0;
    return (
      <div className={`text-xs ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
        {isPositive ? '+' : ''}{changePct.toFixed(2)}%
      </div>
    );
  };

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
          {streamStatus === 'connected' && (
            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-md" title="Streaming real-time quotes via Schwab WebSocket">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              Live
            </span>
          )}
          {streamStatus === 'connecting' && (
            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-md">
              <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
              Connecting...
            </span>
          )}
          {streamStatus === 'outside_hours' && settings?.dataProvider === 'schwab' && (
            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-500 bg-gray-50 border border-gray-200 rounded-md" title="Streaming available during market hours (9:30-16:00 ET)">
              <span className="w-2 h-2 rounded-full bg-gray-400" />
              Market Closed
            </span>
          )}
          {streamStatus === 'error' && (
            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-md" title="Streaming disconnected — using REST fallback">
              <span className="w-2 h-2 rounded-full bg-red-500" />
              Stream Error
            </span>
          )}
          {delayed && streamStatus !== 'connected' && (
            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-md" title="Market data is delayed 15-20 minutes">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Delayed
            </span>
          )}
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

      {refreshMessage && (
        <div
          className={`px-4 py-3 rounded-lg ${
            refreshMessage.type === 'success'
              ? 'bg-green-50 border border-green-200 text-green-700'
              : refreshMessage.type === 'error'
              ? 'bg-red-50 border border-red-200 text-red-700'
              : 'bg-blue-50 border border-blue-200 text-blue-700'
          }`}
        >
          {refreshMessage.text}
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
            <div className="flex items-baseline justify-between">
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
              {lastSynced && (
                <div className="text-xs text-gray-400">
                  Last synced: {lastSynced.toLocaleTimeString()}
                </div>
              )}
            </div>
          </div>

          {/* Risk Shape */}
          <div>
            <button
              onClick={() => setShowRiskShape(!showRiskShape)}
              className="w-full flex items-center justify-between text-lg font-semibold text-gray-900 mb-3 hover:text-gray-700"
            >
              <div className="flex items-center gap-2">
                <span className="text-gray-400">{showRiskShape ? '▼' : '▶'}</span>
                Risk Shape
              </div>
            </button>
            {showRiskShape && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                {/* Book Split */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">Book Split</h3>
                  {(() => {
                    const { bookSplit } = riskShapeData;
                    const total = bookSplit.investing + bookSplit.trading + bookSplit.unassigned;
                    if (total === 0) return <div className="text-sm text-gray-500">No positions</div>;
                    return (
                      <div className="space-y-2">
                        <div className="flex h-4 rounded-full overflow-hidden bg-gray-100">
                          {bookSplit.investing > 0 && (
                            <div className="bg-blue-500" style={{ width: `${(bookSplit.investing / total) * 100}%` }} title={`Investing: ${formatCurrency(bookSplit.investing)}`} />
                          )}
                          {bookSplit.trading > 0 && (
                            <div className="bg-orange-500" style={{ width: `${(bookSplit.trading / total) * 100}%` }} title={`Trading: ${formatCurrency(bookSplit.trading)}`} />
                          )}
                          {bookSplit.unassigned > 0 && (
                            <div className="bg-gray-300" style={{ width: `${(bookSplit.unassigned / total) * 100}%` }} title={`Unassigned: ${formatCurrency(bookSplit.unassigned)}`} />
                          )}
                        </div>
                        <div className="flex flex-wrap gap-3 text-xs">
                          {bookSplit.investing > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-blue-500" />Investing: {formatCurrency(bookSplit.investing)} ({((bookSplit.investing / total) * 100).toFixed(1)}%)</span>}
                          {bookSplit.trading > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-orange-500" />Trading: {formatCurrency(bookSplit.trading)} ({((bookSplit.trading / total) * 100).toFixed(1)}%)</span>}
                          {bookSplit.unassigned > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-gray-300" />Unassigned: {formatCurrency(bookSplit.unassigned)} ({((bookSplit.unassigned / total) * 100).toFixed(1)}%)</span>}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Tier Concentration */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">Tier Concentration</h3>
                  {(() => {
                    const { tierMap, noTier } = riskShapeData;
                    const total = Array.from(tierMap.values()).reduce((a, b) => a + b, 0) + noTier;
                    if (total === 0) return <div className="text-sm text-gray-500">No positions</div>;
                    const tierColors = ['#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd', '#818cf8'];
                    const entries = Array.from(tierMap.entries()).sort((a, b) => b[1] - a[1]);
                    return (
                      <div className="space-y-2">
                        <div className="flex h-4 rounded-full overflow-hidden bg-gray-100">
                          {entries.map(([tier, val], i) => (
                            <div key={tier} style={{ width: `${(val / total) * 100}%`, backgroundColor: tierColors[i % tierColors.length] }} title={`${tier}: ${formatCurrency(val)}`} />
                          ))}
                          {noTier > 0 && (
                            <div className="bg-gray-300" style={{ width: `${(noTier / total) * 100}%` }} title={`No tier: ${formatCurrency(noTier)}`} />
                          )}
                        </div>
                        <div className="flex flex-wrap gap-3 text-xs">
                          {entries.map(([tier, val], i) => (
                            <span key={tier} className="flex items-center gap-1"><span className="w-2 h-2 rounded" style={{ backgroundColor: tierColors[i % tierColors.length] }} />{tier}: {((val / total) * 100).toFixed(1)}%</span>
                          ))}
                          {noTier > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-gray-300" />No tier: {((noTier / total) * 100).toFixed(1)}%</span>}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Sector Exposure */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">Sector Exposure</h3>
                  {(() => {
                    const { sectorMap } = riskShapeData;
                    const total = Array.from(sectorMap.values()).reduce((a, b) => a + b, 0);
                    if (total === 0) return <div className="text-sm text-gray-500">No equity positions</div>;
                    const entries = Array.from(sectorMap.entries()).sort((a, b) => b[1] - a[1]);
                    const sectorColors = ['#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#6366f1', '#f97316', '#84cc16', '#06b6d4'];
                    return (
                      <div className="space-y-2">
                        <div className="flex h-4 rounded-full overflow-hidden bg-gray-100">
                          {entries.map(([sector, val], i) => (
                            <div key={sector} style={{ width: `${(val / total) * 100}%`, backgroundColor: sectorColors[i % sectorColors.length] }} title={`${sector}: ${formatCurrency(val)}`} />
                          ))}
                        </div>
                        <div className="flex flex-wrap gap-3 text-xs">
                          {entries.map(([sector, val], i) => (
                            <span key={sector} className="flex items-center gap-1"><span className="w-2 h-2 rounded" style={{ backgroundColor: sectorColors[i % sectorColors.length] }} />{sector}: {((val / total) * 100).toFixed(1)}%</span>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Account Allocation */}
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">Account Allocation</h3>
                  {(() => {
                    const { acctMap } = riskShapeData;
                    const total = Array.from(acctMap.values()).reduce((a, b) => a + b, 0);
                    if (total === 0) return <div className="text-sm text-gray-500">No positions</div>;
                    const entries = Array.from(acctMap.entries()).sort((a, b) => b[1] - a[1]);
                    const acctColors = ['#0ea5e9', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444'];
                    return (
                      <div className="space-y-2">
                        <div className="flex h-4 rounded-full overflow-hidden bg-gray-100">
                          {entries.map(([name, val], i) => (
                            <div key={name} style={{ width: `${(val / total) * 100}%`, backgroundColor: acctColors[i % acctColors.length] }} title={`${name}: ${formatCurrency(val)}`} />
                          ))}
                        </div>
                        <div className="flex flex-wrap gap-3 text-xs">
                          {entries.map(([name, val], i) => (
                            <span key={name} className="flex items-center gap-1"><span className="w-2 h-2 rounded" style={{ backgroundColor: acctColors[i % acctColors.length] }} />{name}: {formatCurrency(val)} ({((val / total) * 100).toFixed(1)}%)</span>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}
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
                      <th className="table-header text-right">Weight</th>
                      <th className="table-header text-right">Qty</th>
                      <th className="table-header text-right">Price</th>
                      <th className="table-header text-right">Mkt Val / Day</th>
                      <th className="table-header text-right">Gain/Loss</th>
                      <th className="table-header text-right"></th>
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
                            {renderTierBadge(position.intent)}
                          </div>
                          {renderTagBadges(position.tags)}
                        </td>
                        <td className="table-cell text-gray-500 max-w-xs truncate">{position.security?.name || '-'}</td>
                        <td className="table-cell text-right font-semibold">
                          <span className={position.portfolioPercent >= 8 ? 'text-amber-700' : ''}>
                            {position.portfolioPercent.toFixed(1)}%
                          </span>
                        </td>
                        <td className="table-cell text-right">{position.quantity.toLocaleString()}</td>
                        <td className="table-cell text-right">{position.currentPrice ? formatCurrency(position.currentPrice) : '-'}</td>
                        <td className="table-cell text-right">
                          <div>{position.marketValue ? formatCurrency(position.marketValue) : '-'}</div>
                          {renderDayChange(position)}
                        </td>
                        <td className="table-cell text-right">
                          {position.unrealizedGain !== undefined ? (
                            <div className={position.unrealizedGain >= 0 ? 'positive' : 'negative'}>
                              <div>{formatCurrency(position.unrealizedGain)}</div>
                              <div className="text-xs">{formatPercent(position.unrealizedGainPercent || 0)}</div>
                            </div>
                          ) : '-'}
                        </td>
                        <td className="table-cell text-right">
                          {renderActionMenu(position)}
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
                      <th className="table-header text-right">Weight</th>
                      <th className="table-header text-right">Qty</th>
                      <th className="table-header text-right">Price</th>
                      <th className="table-header text-right">Mkt Val / Day</th>
                      <th className="table-header text-right">Gain/Loss</th>
                      <th className="table-header text-right"></th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {normalPositions.map((position) => (
                      <tr key={position.id} className="hover:bg-gray-50">
                        <td className="table-cell font-medium">
                          <div className="flex items-center gap-1">
                            {position.security?.symbol || 'Unknown'}
                            {renderTierBadge(position.intent)}
                          </div>
                          {renderTagBadges(position.tags)}
                        </td>
                        <td className="table-cell text-gray-500 max-w-xs truncate">{position.security?.name || '-'}</td>
                        <td className="table-cell text-right font-medium">{position.portfolioPercent.toFixed(1)}%</td>
                        <td className="table-cell text-right">{position.quantity.toLocaleString()}</td>
                        <td className="table-cell text-right">{position.currentPrice ? formatCurrency(position.currentPrice) : '-'}</td>
                        <td className="table-cell text-right">
                          <div>{position.marketValue ? formatCurrency(position.marketValue) : '-'}</div>
                          {renderDayChange(position)}
                        </td>
                        <td className="table-cell text-right">
                          {position.unrealizedGain !== undefined ? (
                            <div className={position.unrealizedGain >= 0 ? 'positive' : 'negative'}>
                              <div>{formatCurrency(position.unrealizedGain)}</div>
                              <div className="text-xs">{formatPercent(position.unrealizedGainPercent || 0)}</div>
                            </div>
                          ) : '-'}
                        </td>
                        <td className="table-cell text-right">
                          {renderActionMenu(position)}
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
                      <th className="table-header text-right">Weight</th>
                      <th className="table-header text-right">Qty</th>
                      <th className="table-header text-right">Price</th>
                      <th className="table-header text-right">Mkt Val / Day</th>
                      <th className="table-header text-right">Gain/Loss</th>
                      <th className="table-header text-right"></th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {smallPositions.map((position) => (
                      <tr key={position.id} className="hover:bg-gray-50">
                        <td className="table-cell font-medium">
                          <div className="flex items-center gap-1">
                            {position.security?.symbol || 'Unknown'}
                            {renderTierBadge(position.intent)}
                          </div>
                          {renderTagBadges(position.tags)}
                        </td>
                        <td className="table-cell text-gray-500 max-w-xs truncate">{position.security?.name || '-'}</td>
                        <td className="table-cell text-right text-gray-500">{position.portfolioPercent.toFixed(2)}%</td>
                        <td className="table-cell text-right">{position.quantity.toLocaleString()}</td>
                        <td className="table-cell text-right">{position.currentPrice ? formatCurrency(position.currentPrice) : '-'}</td>
                        <td className="table-cell text-right">
                          <div>{position.marketValue ? formatCurrency(position.marketValue) : '-'}</div>
                          {renderDayChange(position)}
                        </td>
                        <td className="table-cell text-right">
                          {position.unrealizedGain !== undefined ? (
                            <div className={position.unrealizedGain >= 0 ? 'positive' : 'negative'}>
                              <div>{formatCurrency(position.unrealizedGain)}</div>
                              <div className="text-xs">{formatPercent(position.unrealizedGainPercent || 0)}</div>
                            </div>
                          ) : '-'}
                        </td>
                        <td className="table-cell text-right">
                          {renderActionMenu(position)}
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
                        <th className="table-header text-right">Qty</th>
                        <th className="table-header text-right">Price</th>
                        <th className="table-header text-right">Mkt Val / Day</th>
                        <th className="table-header text-right">Gain/Loss</th>
                        <th className="table-header text-right"></th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {watchlistPositions.map((position) => (
                        <tr key={position.id} className="hover:bg-gray-50">
                          <td className="table-cell font-medium">
                            <div className="flex items-center gap-1">
                              {position.security?.symbol || 'Unknown'}
                              {renderTierBadge(position.intent)}
                            </div>
                            {renderTagBadges(position.tags)}
                          </td>
                          <td className="table-cell text-gray-500 max-w-xs truncate">{position.security?.name || '-'}</td>
                          <td className="table-cell text-right text-gray-500">{position.quantity.toFixed(4)}</td>
                          <td className="table-cell text-right">{position.currentPrice ? formatCurrency(position.currentPrice) : '-'}</td>
                          <td className="table-cell text-right">
                            <div>{position.marketValue ? formatCurrency(position.marketValue) : '-'}</div>
                            {renderDayChange(position)}
                          </td>
                          <td className="table-cell text-right">
                            {position.unrealizedGain !== undefined ? (
                              <div className={position.unrealizedGain >= 0 ? 'positive' : 'negative'}>
                                <div>{formatCurrency(position.unrealizedGain)}</div>
                                <div className="text-xs">{formatPercent(position.unrealizedGainPercent || 0)}</div>
                              </div>
                            ) : '-'}
                          </td>
                          <td className="table-cell text-right">
                            {renderActionMenu(position)}
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

      {/* Intent Modal */}
      {showIntentModal && intentPosition && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">
              Position Intent
            </h2>
            <p className="text-sm text-gray-500 mb-4">
              {intentPosition.security?.symbol} - {intentPosition.security?.name}
            </p>
            <div className="space-y-4">
              <div>
                <label className="label">Tier</label>
                <input
                  type="text"
                  className="input"
                  value={intentForm.tier}
                  onChange={(e) => setIntentForm({ ...intentForm, tier: e.target.value })}
                  placeholder="e.g., Tier 1, Core, Trade"
                  list="tier-suggestions"
                />
                {existingTiers.length > 0 && (
                  <datalist id="tier-suggestions">
                    {existingTiers.map(t => <option key={t} value={t} />)}
                  </datalist>
                )}
              </div>
              <div>
                <label className="label">Thesis</label>
                <textarea
                  className="input min-h-[80px]"
                  value={intentForm.thesis}
                  onChange={(e) => setIntentForm({ ...intentForm, thesis: e.target.value })}
                  placeholder="Why does this position exist?"
                />
              </div>
              <div>
                <label className="label">Invalidation</label>
                <textarea
                  className="input min-h-[60px]"
                  value={intentForm.invalidation}
                  onChange={(e) => setIntentForm({ ...intentForm, invalidation: e.target.value })}
                  placeholder="What breaks the thesis?"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Entry Style</label>
                  <input
                    type="text"
                    className="input"
                    value={intentForm.entryStyle}
                    onChange={(e) => setIntentForm({ ...intentForm, entryStyle: e.target.value })}
                    placeholder="e.g., DCA, lump sum"
                  />
                </div>
                <div>
                  <label className="label">Target Hold Period</label>
                  <select
                    className="select"
                    value={intentForm.targetHoldPeriod}
                    onChange={(e) => setIntentForm({ ...intentForm, targetHoldPeriod: e.target.value })}
                  >
                    <option value="">-</option>
                    <option value="days">Days</option>
                    <option value="weeks">Weeks</option>
                    <option value="months">Months</option>
                    <option value="years">Years</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-4">
              <button
                type="button"
                onClick={() => { setShowIntentModal(false); setIntentPosition(null); }}
                className="btn-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveIntent}
                className="btn-primary"
              >
                Save Intent
              </button>
            </div>
          </div>
        </div>
      )}

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
                const currentTags = securityTagsMap.get(taggingPosition.securityId) || [];
                const isSelected = currentTags.some(t => t.id === tag.id);
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
