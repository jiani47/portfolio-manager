import { useEffect, useState, useMemo } from 'react';
import { useTaxLots, useAccounts, useSecurities, usePositions, useLotDetailsImport } from '../hooks/useApi';
import type { TaxLot, Security, Position, ParsedOpenLot } from '../../shared/types';
import { format, differenceInDays } from 'date-fns';

interface HoldingGroup {
  symbol: string;
  name: string;
  securityId: string;
  totalShares: number;
  totalCostBasis: number;
  avgCostPerShare: number;
  lots: TaxLot[];
  position?: Position;
  hasMismatch: boolean;
  mismatchDetails?: {
    positionQuantity: number;
    lotQuantity: number;
    positionAvgCost: number;
    lotAvgCost: number;
  };
}

export default function TaxLots() {
  const { taxLots, loading, error, fetchTaxLots, createTaxLot, deleteTaxLotsBySymbol } = useTaxLots();
  const { accounts, fetchAccounts } = useAccounts();
  const { securities, fetchSecurities, createSecurity, findBySymbol } = useSecurities();
  const { positions, fetchPositions } = usePositions();
  const lotDetailsImport = useLotDetailsImport();

  const [showModal, setShowModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [expandedSymbols, setExpandedSymbols] = useState<Set<string>>(new Set());
  const [isImporting, setIsImporting] = useState(false);
  const [importAccountId, setImportAccountId] = useState<string>('');
  const [replaceExisting, setReplaceExisting] = useState(true);

  const [filterAccount, setFilterAccount] = useState<string>('');
  const [sortColumn, setSortColumn] = useState<'symbol' | 'shares' | 'costBasis' | 'avgCost' | 'lots'>('symbol');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [formData, setFormData] = useState({
    accountId: '',
    symbol: '',
    name: '',
    securityType: 'stock' as Security['type'],
    acquisitionDate: format(new Date(), 'yyyy-MM-dd'),
    quantity: '',
    costBasis: '',
  });

  useEffect(() => {
    fetchTaxLots();
    fetchAccounts();
    fetchSecurities();
    fetchPositions();
    lotDetailsImport.fetchParsers();
  }, [fetchTaxLots, fetchAccounts, fetchSecurities, fetchPositions, lotDetailsImport.fetchParsers]);

  const securityMap = useMemo(() => new Map(securities.map(s => [s.id, s])), [securities]);
  const accountMap = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);

  // Filter open lots and group by security
  const holdingGroups = useMemo(() => {
    const openLots = taxLots.filter(t => {
      if (!t.isOpen) return false;
      if (filterAccount && t.accountId !== filterAccount) return false;
      return true;
    });

    // Group by security
    const groupMap = new Map<string, TaxLot[]>();
    for (const lot of openLots) {
      const existing = groupMap.get(lot.securityId) || [];
      existing.push(lot);
      groupMap.set(lot.securityId, existing);
    }

    // Build holding groups with mismatch detection
    const groups: HoldingGroup[] = [];
    for (const [securityId, lots] of groupMap) {
      const security = securityMap.get(securityId);
      if (!security) continue;

      const totalShares = lots.reduce((sum, l) => sum + l.remainingQuantity, 0);
      const totalCostBasis = lots.reduce((sum, l) => sum + (l.costPerShare * l.remainingQuantity), 0);
      const avgCostPerShare = totalShares > 0 ? totalCostBasis / totalShares : 0;

      // Find matching position (account filter considered)
      const matchingPositions = positions.filter(p => {
        if (p.securityId !== securityId) return false;
        if (filterAccount && p.accountId !== filterAccount) return false;
        return true;
      });

      // Sum all matching positions
      const positionQuantity = matchingPositions.reduce((sum, p) => sum + p.quantity, 0);
      const positionCostBasis = matchingPositions.reduce((sum, p) => sum + p.costBasis, 0);
      const positionAvgCost = positionQuantity > 0 ? positionCostBasis / positionQuantity : 0;

      // Mismatch detection
      const quantityMismatch = Math.abs(positionQuantity - totalShares) > 0.001;
      const avgCostMismatch = positionQuantity > 0 && Math.abs(positionAvgCost - avgCostPerShare) > 0.50;
      const hasMismatch = quantityMismatch || avgCostMismatch;

      groups.push({
        symbol: security.symbol,
        name: security.name,
        securityId,
        totalShares,
        totalCostBasis,
        avgCostPerShare,
        lots: lots.sort((a, b) => new Date(b.acquisitionDate).getTime() - new Date(a.acquisitionDate).getTime()),
        position: matchingPositions[0],
        hasMismatch: hasMismatch && positionQuantity > 0,
        mismatchDetails: hasMismatch && positionQuantity > 0 ? {
          positionQuantity,
          lotQuantity: totalShares,
          positionAvgCost,
          lotAvgCost: avgCostPerShare,
        } : undefined,
      });
    }

    // Sort by selected column
    return groups.sort((a, b) => {
      let comparison = 0;
      switch (sortColumn) {
        case 'symbol':
          comparison = a.symbol.localeCompare(b.symbol);
          break;
        case 'shares':
          comparison = a.totalShares - b.totalShares;
          break;
        case 'costBasis':
          comparison = a.totalCostBasis - b.totalCostBasis;
          break;
        case 'avgCost':
          comparison = a.avgCostPerShare - b.avgCostPerShare;
          break;
        case 'lots':
          comparison = a.lots.length - b.lots.length;
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [taxLots, filterAccount, securityMap, positions, sortColumn, sortDirection]);

  const toggleExpanded = (symbol: string) => {
    setExpandedSymbols(prev => {
      const next = new Set(prev);
      if (next.has(symbol)) {
        next.delete(symbol);
      } else {
        next.add(symbol);
      }
      return next;
    });
  };

  const handleSort = (column: typeof sortColumn) => {
    if (sortColumn === column) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const SortIndicator = ({ column }: { column: typeof sortColumn }) => {
    if (sortColumn !== column) return <span className="text-gray-300 ml-1">↕</span>;
    return <span className="text-blue-600 ml-1">{sortDirection === 'asc' ? '↑' : '↓'}</span>;
  };

  const expandAll = () => {
    setExpandedSymbols(new Set(holdingGroups.map(g => g.symbol)));
  };

  const collapseAll = () => {
    setExpandedSymbols(new Set());
  };

  const handleOpenModal = () => {
    setFormData({
      accountId: accounts[0]?.id || '',
      symbol: '',
      name: '',
      securityType: 'stock',
      acquisitionDate: format(new Date(), 'yyyy-MM-dd'),
      quantity: '',
      costBasis: '',
    });
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
  };

  const handleOpenImportModal = () => {
    setImportAccountId(accounts[0]?.id || '');
    setReplaceExisting(true);
    lotDetailsImport.clearResults();
    setShowImportModal(true);
  };

  const handleCloseImportModal = () => {
    setShowImportModal(false);
    lotDetailsImport.clearResults();
  };

  const handleSelectLotDetailsFiles = async () => {
    const filePaths = await lotDetailsImport.selectFiles();
    if (filePaths.length > 0) {
      await lotDetailsImport.parseLotDetailsFiles('schwab-lot-details', filePaths);
    }
  };

  const handleImportLots = async () => {
    if (!importAccountId || lotDetailsImport.parseResults.length === 0) return;

    setIsImporting(true);
    try {
      // Track which symbols we've already deleted lots for (to avoid duplicate deletes)
      const deletedSymbols = new Set<string>();

      for (const result of lotDetailsImport.parseResults) {
        // Find or create security first
        let security = await findBySymbol(result.symbol);
        if (!security) {
          security = await createSecurity({
            symbol: result.symbol,
            name: result.symbol,
            type: 'stock',
            currency: 'USD',
          });
        }

        // Delete existing lots for this symbol if replace option is selected
        if (replaceExisting && !deletedSymbols.has(result.symbol)) {
          await deleteTaxLotsBySymbol(importAccountId, security.id);
          deletedSymbols.add(result.symbol);
        }

        // Create new lots
        for (const lot of result.lots) {
          await createTaxLot({
            accountId: importAccountId,
            securityId: security.id,
            transactionId: null as unknown as string, // No transaction for imported lots
            acquisitionDate: lot.openDate,
            quantity: lot.quantity,
            costBasis: lot.costBasis,
            costPerShare: lot.costPerShare,
            remainingQuantity: lot.quantity,
            isOpen: true,
            holdingPeriod: lot.holdingPeriod,
          });
        }
      }

      await fetchTaxLots();
      await fetchSecurities();
      handleCloseImportModal();
    } catch (err) {
      console.error('Failed to import lots:', err);
    } finally {
      setIsImporting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      let security = await findBySymbol(formData.symbol);
      if (!security) {
        security = await createSecurity({
          symbol: formData.symbol.toUpperCase(),
          name: formData.name || formData.symbol.toUpperCase(),
          type: formData.securityType,
          currency: 'USD',
        });
      }

      const quantity = parseFloat(formData.quantity);
      const costBasis = parseFloat(formData.costBasis);
      const costPerShare = costBasis / quantity;

      await createTaxLot({
        accountId: formData.accountId,
        securityId: security.id,
        transactionId: 'manual-entry',
        acquisitionDate: formData.acquisitionDate,
        quantity,
        costBasis,
        costPerShare,
        remainingQuantity: quantity,
        isOpen: true,
      });

      handleCloseModal();
      fetchSecurities();
    } catch (err) {
      console.error('Failed to create tax lot:', err);
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(value);
  };

  const getDaysHeld = (acquisitionDate: string) => {
    return differenceInDays(new Date(), new Date(acquisitionDate));
  };

  const getHoldingPeriod = (acquisitionDate: string): 'short' | 'long' => {
    return getDaysHeld(acquisitionDate) >= 365 ? 'long' : 'short';
  };

  // Calculate totals
  const totals = useMemo(() => {
    const totalCostBasis = holdingGroups.reduce((sum, g) => sum + g.totalCostBasis, 0);
    const totalShares = holdingGroups.reduce((sum, g) => sum + g.totalShares, 0);
    const totalHoldings = holdingGroups.length;
    const totalLots = holdingGroups.reduce((sum, g) => sum + g.lots.length, 0);
    const mismatchCount = holdingGroups.filter(g => g.hasMismatch).length;
    return { totalCostBasis, totalShares, totalHoldings, totalLots, mismatchCount };
  }, [holdingGroups]);

  // Get total lots across all parse results for preview
  const totalParsedLots = lotDetailsImport.parseResults.reduce((sum, r) => sum + r.lots.length, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Tax Lots</h1>
        <div className="flex gap-2">
          <button onClick={handleOpenImportModal} className="btn-secondary">
            Import from Brokerage
          </button>
          <button onClick={handleOpenModal} className="btn-primary">
            Add Tax Lot
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card">
          <p className="stat-label">Total Cost Basis</p>
          <p className="stat-value text-lg">{formatCurrency(totals.totalCostBasis)}</p>
        </div>
        <div className="card">
          <p className="stat-label">Holdings</p>
          <p className="stat-value text-lg">{totals.totalHoldings}</p>
        </div>
        <div className="card">
          <p className="stat-label">Open Lots</p>
          <p className="stat-value text-lg">{totals.totalLots}</p>
        </div>
        <div className="card">
          <p className="stat-label">Mismatches</p>
          <p className={`stat-value text-lg ${totals.mismatchCount > 0 ? 'text-yellow-600' : 'text-green-600'}`}>
            {totals.mismatchCount}
          </p>
        </div>
      </div>

      {/* Filters and controls */}
      <div className="flex items-center justify-between">
        <div className="flex gap-4">
          <select
            className="select w-48"
            value={filterAccount}
            onChange={(e) => setFilterAccount(e.target.value)}
          >
            <option value="">All Accounts</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-2">
          <button onClick={expandAll} className="text-sm text-blue-600 hover:text-blue-800">
            Expand All
          </button>
          <span className="text-gray-300">|</span>
          <button onClick={collapseAll} className="text-sm text-blue-600 hover:text-blue-800">
            Collapse All
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
      ) : holdingGroups.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-gray-500">No open tax lots.</p>
          <p className="text-sm text-gray-400 mt-1">Import lots from your brokerage or add them manually.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Sortable header row */}
          <div className="flex items-center px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wider bg-gray-50 rounded-lg">
            <div className="w-8"></div>
            <button
              onClick={() => handleSort('symbol')}
              className="flex-1 text-left hover:text-gray-700 flex items-center"
            >
              Symbol<SortIndicator column="symbol" />
            </button>
            <button
              onClick={() => handleSort('lots')}
              className="w-20 text-right hover:text-gray-700 flex items-center justify-end"
            >
              Lots<SortIndicator column="lots" />
            </button>
            <button
              onClick={() => handleSort('shares')}
              className="w-32 text-right hover:text-gray-700 flex items-center justify-end"
            >
              Shares<SortIndicator column="shares" />
            </button>
            <button
              onClick={() => handleSort('avgCost')}
              className="w-32 text-right hover:text-gray-700 flex items-center justify-end"
            >
              Avg Cost<SortIndicator column="avgCost" />
            </button>
            <button
              onClick={() => handleSort('costBasis')}
              className="w-32 text-right hover:text-gray-700 flex items-center justify-end"
            >
              Cost Basis<SortIndicator column="costBasis" />
            </button>
          </div>

          {holdingGroups.map((group) => {
            const isExpanded = expandedSymbols.has(group.symbol);
            return (
              <div key={group.securityId} className="card overflow-hidden p-0">
                {/* Holding header - clickable to expand */}
                <button
                  onClick={() => toggleExpanded(group.symbol)}
                  className="w-full px-4 py-3 flex items-center hover:bg-gray-50 transition-colors text-left"
                >
                  <span className="w-8 text-gray-400 text-sm flex-shrink-0">
                    {isExpanded ? '▼' : '▶'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-900">{group.symbol}</span>
                      <span className="text-gray-500">-</span>
                      <span className="text-gray-600 truncate">{group.name}</span>
                      {group.hasMismatch && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800 flex-shrink-0">
                          MISMATCH
                        </span>
                      )}
                    </div>
                    {group.hasMismatch && group.mismatchDetails && (
                      <div className="text-xs text-yellow-700 mt-1">
                        Position: {group.mismatchDetails.positionQuantity} shares @ {formatCurrency(group.mismatchDetails.positionAvgCost)} avg
                        {' | '}
                        Tax Lots: {group.mismatchDetails.lotQuantity} shares @ {formatCurrency(group.mismatchDetails.lotAvgCost)} avg
                      </div>
                    )}
                  </div>
                  <div className="w-20 text-right text-sm text-gray-500 flex-shrink-0">
                    {group.lots.length}
                  </div>
                  <div className="w-32 text-right font-medium text-gray-900 flex-shrink-0">
                    {group.totalShares.toLocaleString()}
                  </div>
                  <div className="w-32 text-right text-sm text-gray-600 flex-shrink-0">
                    {formatCurrency(group.avgCostPerShare)}
                  </div>
                  <div className="w-32 text-right font-medium text-gray-900 flex-shrink-0">
                    {formatCurrency(group.totalCostBasis)}
                  </div>
                </button>

                {/* Expanded lot details */}
                {isExpanded && (
                  <div className="border-t border-gray-200">
                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Acquisition Date</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Account</th>
                          <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">Quantity</th>
                          <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">Cost/Share</th>
                          <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">Cost Basis</th>
                          <th className="px-4 py-2 text-center text-xs font-medium text-gray-500">Period</th>
                          <th className="px-4 py-2 text-center text-xs font-medium text-gray-500">Days Held</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {group.lots.map((lot) => {
                          const account = accountMap.get(lot.accountId);
                          const daysHeld = getDaysHeld(lot.acquisitionDate);
                          const period = lot.holdingPeriod || getHoldingPeriod(lot.acquisitionDate);
                          return (
                            <tr key={lot.id} className="hover:bg-gray-50">
                              <td className="px-4 py-2 text-gray-600">
                                {format(new Date(lot.acquisitionDate), 'MM/dd/yyyy')}
                              </td>
                              <td className="px-4 py-2 text-gray-500">{account?.name || 'Unknown'}</td>
                              <td className="px-4 py-2 text-right">{lot.remainingQuantity.toLocaleString()}</td>
                              <td className="px-4 py-2 text-right">{formatCurrency(lot.costPerShare)}</td>
                              <td className="px-4 py-2 text-right">
                                {formatCurrency(lot.costPerShare * lot.remainingQuantity)}
                              </td>
                              <td className="px-4 py-2 text-center">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                  period === 'long' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'
                                }`}>
                                  {period === 'long' ? 'Long' : 'Short'}
                                </span>
                              </td>
                              <td className="px-4 py-2 text-center text-gray-500">{daysHeld}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add Tax Lot Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Add Tax Lot</h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="label">Account</label>
                <select
                  className="select"
                  value={formData.accountId}
                  onChange={(e) => setFormData({ ...formData, accountId: e.target.value })}
                  required
                >
                  <option value="">Select Account</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Symbol</label>
                  <input
                    type="text"
                    className="input"
                    value={formData.symbol}
                    onChange={(e) => setFormData({ ...formData, symbol: e.target.value.toUpperCase() })}
                    placeholder="e.g., AAPL"
                    required
                  />
                </div>
                <div>
                  <label className="label">Security Type</label>
                  <select
                    className="select"
                    value={formData.securityType}
                    onChange={(e) => setFormData({ ...formData, securityType: e.target.value as Security['type'] })}
                  >
                    <option value="stock">Stock</option>
                    <option value="etf">ETF</option>
                    <option value="mutual_fund">Mutual Fund</option>
                    <option value="bond">Bond</option>
                    <option value="option">Option</option>
                    <option value="crypto">Crypto</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="label">Acquisition Date</label>
                <input
                  type="date"
                  className="input"
                  value={formData.acquisitionDate}
                  onChange={(e) => setFormData({ ...formData, acquisitionDate: e.target.value })}
                  required
                />
              </div>
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
                  <label className="label">Total Cost Basis ($)</label>
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
              <div className="flex justify-end gap-3 pt-4">
                <button type="button" onClick={handleCloseModal} className="btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Add Tax Lot
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Import from Brokerage Modal */}
      {showImportModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Import Tax Lots from Brokerage</h2>

            <div className="space-y-4">
              <div>
                <label className="label">Target Account</label>
                <select
                  className="select"
                  value={importAccountId}
                  onChange={(e) => setImportAccountId(e.target.value)}
                >
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={replaceExisting}
                    onChange={(e) => setReplaceExisting(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm font-medium text-gray-700">Replace existing lots</span>
                </label>
                <span className="text-xs text-gray-500">
                  {replaceExisting ? '(Delete existing lots for imported symbols only)' : '(Add to existing lots)'}
                </span>
              </div>

              <div className="border rounded-lg p-4">
                <h3 className="font-medium text-gray-900 mb-2">Select Lot Details CSV Files</h3>
                <p className="text-sm text-gray-500 mb-3">
                  Export "Lot Details" from Schwab for each holding and select the CSV files here.
                  You can select multiple files.
                </p>
                <button
                  onClick={handleSelectLotDetailsFiles}
                  disabled={lotDetailsImport.loading}
                  className="btn-secondary w-full"
                >
                  {lotDetailsImport.loading ? 'Parsing...' : 'Select Lot Details CSV Files'}
                </button>
                {lotDetailsImport.error && (
                  <p className="text-sm text-red-600 mt-2">{lotDetailsImport.error}</p>
                )}
              </div>

              {/* Preview parsed lots */}
              {lotDetailsImport.parseResults.length > 0 && (
                <div className="border rounded-lg overflow-hidden">
                  <div className="bg-gray-50 px-4 py-3 border-b">
                    <h4 className="font-medium text-gray-900">
                      Preview ({totalParsedLots} lots from {lotDetailsImport.parseResults.length} file{lotDetailsImport.parseResults.length > 1 ? 's' : ''})
                    </h4>
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Symbol</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Open Date</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">Quantity</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">Cost/Share</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">Cost Basis</th>
                          <th className="px-3 py-2 text-center text-xs font-medium text-gray-500">Period</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {lotDetailsImport.parseResults.flatMap(result =>
                          result.lots.map((lot, i) => (
                            <tr key={`${result.symbol}-${i}`} className="hover:bg-gray-50">
                              <td className="px-3 py-2 font-medium">{lot.symbol}</td>
                              <td className="px-3 py-2 text-gray-600">{lot.openDate}</td>
                              <td className="px-3 py-2 text-right">{lot.quantity}</td>
                              <td className="px-3 py-2 text-right">{formatCurrency(lot.costPerShare)}</td>
                              <td className="px-3 py-2 text-right">{formatCurrency(lot.costBasis)}</td>
                              <td className="px-3 py-2 text-center">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                  lot.holdingPeriod === 'long' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'
                                }`}>
                                  {lot.holdingPeriod === 'long' ? 'Long' : 'Short'}
                                </span>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-4">
                <button type="button" onClick={handleCloseImportModal} className="btn-secondary">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleImportLots}
                  disabled={isImporting || totalParsedLots === 0}
                  className="btn-primary"
                >
                  {isImporting ? 'Importing...' : `Import ${totalParsedLots} Lots`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
