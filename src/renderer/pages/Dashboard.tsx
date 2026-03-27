import { useEffect, useState, useMemo, useCallback } from 'react';
import { usePortfolio, usePositions, useSecurities, useSettings, usePositionIntents, useDailyRituals, useNews, useEarnings, useAnalytics } from '../hooks/useApi';
import { useStreamingQuotes } from '../hooks/useStreamingQuotes';
import type { StreamingQuote, NewsArticle, EarningsEvent } from '../../shared/types';
import { calculateAllocationDrift, type AllocationRow } from '../../shared/analytics/allocation';
import { format, addDays } from 'date-fns';

const TIER_COLORS: Record<string, string> = {
  'Core': '#3b82f6',
  'Growth': '#10b981',
  'Starter': '#f59e0b',
  'Watchlist': '#f97316',
};

export default function Dashboard() {
  const { summary, loading: portfolioLoading, fetchSummary } = usePortfolio();
  const { positions, loading: positionsLoading, fetchPositions } = usePositions();
  const { securities, fetchSecurities } = useSecurities();
  const { settings, fetchSettings } = useSettings();
  const { intents, fetchIntents } = usePositionIntents();
  const { rituals, fetchRituals } = useDailyRituals();
  const { articles: newsArticles, fetchRecentNews } = useNews();
  const { earnings, fetchPortfolioEarnings } = useEarnings();
  const { positionBetas, fetchAnalytics } = useAnalytics();
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [rawSectorData, setRawSectorData] = useState<{ nyse: Record<string, number>; nasdaq: Record<string, number> } | null>(null);
  const [sectorDate, setSectorDate] = useState<string>('');
  const [sectorView, setSectorView] = useState<'all' | 'nyse' | 'nasdaq'>('all');
  const [newsTab, setNewsTab] = useState<'all' | 'positions' | 'watchlist'>('all');
  const [watchlistSymbols, setWatchlistSymbols] = useState<string[]>([]);

  useEffect(() => {
    fetchSummary();
    fetchPositions();
    fetchSecurities();
    fetchSettings();
    fetchIntents();
    fetchRituals(1);
    fetchRecentNews(24);
    fetchAnalytics(90);
    const today = format(new Date(), 'yyyy-MM-dd');
    const twoWeeksOut = format(addDays(new Date(), 14), 'yyyy-MM-dd');
    fetchPortfolioEarnings(today, twoWeeksOut);
    window.electronAPI.getWatchlistSymbols().then(setWatchlistSymbols).catch(() => {});
  }, [fetchSummary, fetchPositions, fetchSecurities, fetchSettings, fetchIntents, fetchRituals, fetchRecentNews, fetchAnalytics, fetchPortfolioEarnings]);

  // Listen for position sync events
  useEffect(() => {
    const removeListener = window.electronAPI.onPositionsSynced(() => {
      setLastSynced(new Date());
      fetchPositions();
      fetchSummary();
    });
    return () => removeListener();
  }, [fetchPositions, fetchSummary]);

  // Fetch sector data via main process (avoids CORS)
  useEffect(() => {
    window.electronAPI.getSectorPerformance().then((result) => {
      if (result) {
        setRawSectorData({ nyse: result.nyse, nasdaq: result.nasdaq });
        setSectorDate(result.date);
      }
    }).catch(() => {});
  }, []);

  // SPY (S&P 500) sector weights — source: stockanalysis.com
  const SPY_SECTOR_WEIGHTS: Record<string, number> = useMemo(() => ({
    'Technology': 34.24,
    'Financial Services': 12.05,
    'Healthcare': 11.18,
    'Consumer Cyclical': 10.26,
    'Communication Services': 8.98,
    'Industrials': 7.62,
    'Consumer Defensive': 5.95,
    'Energy': 3.40,
    'Utilities': 2.66,
    'Real Estate': 2.10,
    'Basic Materials': 1.56,
  }), []);

  // QQQ (Nasdaq-100) sector weights — source: stockanalysis.com
  const QQQ_SECTOR_WEIGHTS: Record<string, number> = useMemo(() => ({
    'Technology': 53.60,
    'Consumer Cyclical': 13.04,
    'Communication Services': 12.48,
    'Healthcare': 6.31,
    'Consumer Defensive': 4.64,
    'Industrials': 4.40,
    'Financial Services': 2.37,
    'Utilities': 2.07,
    'Energy': 0.56,
    'Basic Materials': 0.39,
    'Real Estate': 0.15,
  }), []);

  // Compute sector data based on selected view
  const sectorData = useMemo(() => {
    if (!rawSectorData) return [];
    let data: Record<string, number>;
    if (sectorView === 'nyse') {
      data = rawSectorData.nyse;
    } else if (sectorView === 'nasdaq') {
      data = rawSectorData.nasdaq;
    } else {
      // Merge: average where both exist, otherwise take whichever has it
      data = {};
      const allSectors = new Set([...Object.keys(rawSectorData.nyse), ...Object.keys(rawSectorData.nasdaq)]);
      for (const sector of allSectors) {
        const nyseVal = rawSectorData.nyse[sector];
        const nasdaqVal = rawSectorData.nasdaq[sector];
        if (nyseVal !== undefined && nasdaqVal !== undefined) {
          data[sector] = (nyseVal + nasdaqVal) / 2;
        } else {
          data[sector] = nyseVal ?? nasdaqVal;
        }
      }
    }
    return Object.entries(data)
      .map(([sector, change]) => ({ sector, change }))
      .sort((a, b) => b.change - a.change);
  }, [rawSectorData, sectorView]);

  const indexWeights = sectorView === 'nyse' ? SPY_SECTOR_WEIGHTS : sectorView === 'nasdaq' ? QQQ_SECTOR_WEIGHTS : null;

  const loading = portfolioLoading || positionsLoading;
  const securityMap = useMemo(() => new Map(securities.map(s => [s.id, s])), [securities]);

  // Position symbols for news filtering
  const positionSymbols = useMemo(() => {
    const syms = new Set<string>();
    for (const p of positions) {
      const s = securityMap.get(p.securityId);
      if (s && s.type !== 'cash' && s.symbol) syms.add(s.symbol);
    }
    return syms;
  }, [positions, securityMap]);

  const watchlistSymbolSet = useMemo(() => new Set(watchlistSymbols), [watchlistSymbols]);

  // Filtered news based on selected tab
  const filteredNews = useMemo(() => {
    return newsArticles.filter(a => {
      if (newsTab === 'all') return positionSymbols.has(a.symbol) || watchlistSymbolSet.has(a.symbol);
      if (newsTab === 'positions') return positionSymbols.has(a.symbol);
      return watchlistSymbolSet.has(a.symbol);
    });
  }, [newsArticles, newsTab, positionSymbols, watchlistSymbolSet]);

  // Streaming quotes — include SPY and QQQ for indices
  const symbolList = useMemo(() => {
    const syms = positions
      .map(p => securityMap.get(p.securityId))
      .filter(s => s && s.type !== 'cash' && s.type !== 'option')
      .map(s => s!.symbol);
    if (!syms.includes('SPY')) syms.push('SPY');
    if (!syms.includes('QQQ')) syms.push('QQQ');
    return syms;
  }, [positions, securityMap]);
  const { quotes: streamingQuotes } = useStreamingQuotes(symbolList);

  // Today's ritual
  const todayRitual = useMemo(() => {
    const today = format(new Date(), 'yyyy-MM-dd');
    return rituals.find(r => r.date === today) || null;
  }, [rituals]);

  // Portfolio value and day change from streaming data
  const { portfolioValue, portfolioDayChange } = useMemo(() => {
    let totalValue = 0;
    let totalChange = 0;
    for (const pos of positions) {
      const security = securityMap.get(pos.securityId);
      if (!security) continue;
      if (security.type === 'cash') {
        totalValue += pos.quantity;
        continue;
      }
      const quote = streamingQuotes.get(security.symbol);
      if (quote?.last) {
        totalValue += quote.last * pos.quantity;
        if (quote.netChange) {
          totalChange += quote.netChange * pos.quantity;
        }
      } else if (pos.marketValue) {
        // Fallback to DB market value if no streaming quote
        totalValue += pos.marketValue;
      }
    }
    return { portfolioValue: totalValue, portfolioDayChange: totalChange };
  }, [positions, securityMap, streamingQuotes]);

  // Top movers from streaming data (deduped by symbol)
  const topMovers = useMemo(() => {
    const seen = new Set<string>();
    const movers: { symbol: string; price: number; change: number; changePct: number; tier?: string }[] = [];
    for (const pos of positions) {
      const security = securityMap.get(pos.securityId);
      if (!security || security.type === 'cash') continue;
      if (seen.has(security.symbol)) continue;
      seen.add(security.symbol);
      const quote = streamingQuotes.get(security.symbol);
      if (!quote?.netChangePct) continue;
      const intent = intents.get(pos.id);
      movers.push({
        symbol: security.symbol,
        price: quote.last || 0,
        change: quote.netChange || 0,
        changePct: quote.netChangePct || 0,
        tier: intent?.tier,
      });
    }
    movers.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
    const result = movers.slice(0, 8);
    // Debug: log top movers computation
    if (result.length > 0) {
      console.log('[TopMovers] Computed:', result.map(m => `${m.symbol} last=$${m.price.toFixed(2)} chg=${m.change.toFixed(2)} pct=${m.changePct.toFixed(2)}%`).join(' | '));
      // Also log raw quote data for top 3
      for (const m of result.slice(0, 3)) {
        const q = streamingQuotes.get(m.symbol);
        if (q) console.log(`[TopMovers:raw] ${m.symbol} quote:`, JSON.stringify({ last: q.last, netChange: q.netChange, netChangePct: q.netChangePct, close: q.close, open: q.open, timestamp: q.timestamp }));
      }
    }
    return result;
  }, [positions, securityMap, streamingQuotes, intents]);

  // Portfolio sector performance from streaming data
  const portfolioSectorPerf = useMemo(() => {
    const sectorMap: Record<string, { dayPnl: number; marketValue: number; symbols: string[] }> = {};
    const seen = new Set<string>();
    let totalMv = 0;
    for (const pos of positions) {
      const security = securityMap.get(pos.securityId);
      if (!security || security.type === 'cash' || security.type === 'option') continue;
      if (seen.has(security.symbol)) continue;
      seen.add(security.symbol);
      const sector = security.sector || 'Unknown';
      if (!sectorMap[sector]) sectorMap[sector] = { dayPnl: 0, marketValue: 0, symbols: [] };
      const quote = streamingQuotes.get(security.symbol);
      const dayPnl = (quote?.netChange || 0) * pos.quantity;
      sectorMap[sector].dayPnl += dayPnl;
      sectorMap[sector].marketValue += pos.marketValue || 0;
      sectorMap[sector].symbols.push(security.symbol);
      totalMv += pos.marketValue || 0;
    }
    return Object.entries(sectorMap)
      .map(([sector, data]) => ({
        sector,
        dayPnl: data.dayPnl,
        marketValue: data.marketValue,
        portfolioPct: totalMv > 0 ? (data.marketValue / totalMv) * 100 : 0,
        dayPct: data.marketValue > 0 ? (data.dayPnl / (data.marketValue - data.dayPnl)) * 100 : 0,
        symbols: data.symbols.sort(),
      }))
      .filter(s => s.marketValue > 0)
      .sort((a, b) => b.marketValue - a.marketValue);
  }, [positions, securityMap, streamingQuotes]);

  // Market indices from streaming
  const spyQuote = streamingQuotes.get('SPY');
  const qqqQuote = streamingQuotes.get('QQQ');

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

  const renderIndexCard = (label: string, quote: StreamingQuote | undefined) => {
    if (!quote) {
      return (
        <div className="card">
          <p className="stat-label">{label}</p>
          <p className="stat-value text-gray-300">--</p>
        </div>
      );
    }
    const isPositive = (quote.netChange || 0) >= 0;
    return (
      <div className="card">
        <p className="stat-label">{label}</p>
        <p className="stat-value">{formatCurrency(quote.last)}</p>
        <p className={`text-sm font-medium ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
          {isPositive ? '+' : ''}{formatCurrency(quote.netChange || 0)} ({formatPercent(quote.netChangePct || 0)})
        </p>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <div className="flex items-center gap-3">
          {lastSynced && (
            <span className="text-xs text-gray-400">
              Last synced: {lastSynced.toLocaleTimeString()}
            </span>
          )}
          <button onClick={() => { fetchSummary(); fetchPositions(); fetchRituals(1); }} className="btn-secondary text-sm">
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-500">Loading...</div>
        </div>
      ) : (
        <>
          {/* Market Indices + Portfolio Summary */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {renderIndexCard('S&P 500 (SPY)', spyQuote)}
            {renderIndexCard('Nasdaq (QQQ)', qqqQuote)}
            <div className="card">
              <p className="stat-label">Portfolio Value</p>
              <p className="stat-value">{formatCurrency(portfolioValue || summary?.totalValue || 0)}</p>
              {portfolioDayChange !== 0 ? (
                <p className={`text-sm font-medium ${portfolioDayChange >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {portfolioDayChange >= 0 ? '+' : ''}{formatCurrency(portfolioDayChange)} ({((portfolioDayChange / ((portfolioValue || summary?.totalValue || 1) - portfolioDayChange)) * 100).toFixed(2)}%) today
                </p>
              ) : (
                <p className="text-sm text-gray-400">{summary?.positionCount || 0} positions</p>
              )}
            </div>
          </div>

          {/* Today's Regime */}
          <div className="card">
            <h2 className="text-lg font-semibold text-gray-900 mb-3">Today's Regime</h2>
            {todayRitual && (todayRitual.regimeRewarding || todayRitual.regimePunishing) ? (
              <div className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <span className="text-xs font-medium text-gray-500 uppercase">Type</span>
                    <div className="mt-1">
                      {todayRitual.regimeType === 'trend' ? (
                        <span className="inline-flex items-center px-2.5 py-1 rounded-md text-sm font-medium bg-blue-100 text-blue-800">Trend Day</span>
                      ) : todayRitual.regimeType === 'sorting' ? (
                        <span className="inline-flex items-center px-2.5 py-1 rounded-md text-sm font-medium bg-amber-100 text-amber-800">Sorting Day</span>
                      ) : (
                        <span className="text-gray-400 text-sm">Not set</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <span className="text-xs font-medium text-gray-500 uppercase">Rewarding</span>
                    <p className="mt-1 text-sm text-green-700">{todayRitual.regimeRewarding || '-'}</p>
                  </div>
                  <div>
                    <span className="text-xs font-medium text-gray-500 uppercase">Punishing</span>
                    <p className="mt-1 text-sm text-red-700">{todayRitual.regimePunishing || '-'}</p>
                  </div>
                </div>
                {todayRitual.actionChosen && (
                  <div className="border-t border-gray-100 pt-2">
                    <span className="text-xs font-medium text-gray-500 uppercase">Action</span>
                    <p className="mt-1 text-sm">
                      <span className="font-medium capitalize">{todayRitual.actionChosen}</span>
                      {todayRitual.actionDetail && <span className="text-gray-500"> — {todayRitual.actionDetail}</span>}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-400">No regime set today. Run the mid-morning ritual after 10:30am ET.</p>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Top Movers */}
            <div className="card">
              <h2 className="text-lg font-semibold text-gray-900 mb-3">Top Movers</h2>
              {topMovers.length > 0 ? (
                <div className="space-y-1">
                  {topMovers.map(m => {
                    const isPositive = m.changePct >= 0;
                    const tierColor = m.tier ? (TIER_COLORS[m.tier] || '#9ca3af') : undefined;
                    return (
                      <div key={m.symbol} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-gray-50">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm w-12">{m.symbol}</span>
                          {tierColor && (
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: tierColor }} title={m.tier} />
                          )}
                        </div>
                        <div className="text-right">
                          <span className="text-sm">{formatCurrency(m.price)}</span>
                          <span className={`ml-3 text-sm font-medium ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
                            {formatPercent(m.changePct)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-gray-400">Waiting for streaming data...</p>
              )}
            </div>

            {/* Market Sector Heatmap */}
            <div className="card">
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-lg font-semibold text-gray-900">Market Sectors</h2>
                <div className="flex rounded-md overflow-hidden border border-gray-200">
                  {(['all', 'nyse', 'nasdaq'] as const).map(view => (
                    <button
                      key={view}
                      onClick={() => setSectorView(view)}
                      className={`px-2 py-0.5 text-xs font-medium ${
                        sectorView === view
                          ? 'bg-blue-600 text-white'
                          : 'bg-white text-gray-600 hover:bg-gray-50'
                      } ${view !== 'all' ? 'border-l border-gray-200' : ''}`}
                    >
                      {view === 'all' ? 'All' : view === 'nyse' ? 'NYSE (SPY)' : 'NASDAQ (QQQ)'}
                    </button>
                  ))}
                </div>
              </div>
              {sectorDate && <p className="text-xs text-gray-400 mb-3">{sectorDate}</p>}
              {sectorData.length > 0 ? (
                <div className="space-y-1.5">
                  {sectorData.map(s => {
                    const isPositive = s.change >= 0;
                    const barWidth = Math.min(Math.abs(s.change) * 15, 100);
                    const weight = indexWeights?.[s.sector];
                    return (
                      <div key={s.sector} className="flex items-center gap-2">
                        <span className="text-xs w-36 truncate text-gray-600">{s.sector}</span>
                        {indexWeights && (
                          <span className="text-xs w-10 text-right text-gray-400">{weight ? `${weight.toFixed(1)}%` : '-'}</span>
                        )}
                        <div className="flex-1 flex items-center">
                          <div className="w-full h-4 bg-gray-50 rounded relative overflow-hidden">
                            <div
                              className={`h-full rounded ${isPositive ? 'bg-green-400' : 'bg-red-400'}`}
                              style={{ width: `${barWidth}%`, opacity: 0.7 }}
                            />
                          </div>
                        </div>
                        <span className={`text-xs font-medium w-14 text-right ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
                          {isPositive ? '+' : ''}{s.change.toFixed(2)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-gray-400">No sector data available</p>
              )}
            </div>
          </div>

          {/* Portfolio Sector Performance */}
          <div className="card">
            <h2 className="text-lg font-semibold text-gray-900 mb-3">My Sector Performance</h2>
            {portfolioSectorPerf.length > 0 ? (
              <div className="space-y-2">
                {portfolioSectorPerf.map(s => {
                  const isPositive = s.dayPct >= 0;
                  return (
                    <div key={s.sector} className="py-1.5 px-2 rounded hover:bg-gray-50">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-800">{s.sector}</span>
                          <span className="text-xs text-gray-400">{s.portfolioPct.toFixed(1)}%</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className={`text-xs font-medium ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
                            {isPositive ? '+' : ''}{formatCurrency(s.dayPnl)}
                          </span>
                          <span className={`text-xs font-medium w-14 text-right ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
                            {isPositive ? '+' : ''}{s.dayPct.toFixed(2)}%
                          </span>
                        </div>
                      </div>
                      <div className="mt-0.5">
                        <span className="text-xs text-gray-400">{s.symbols.join(', ')}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-gray-400">Waiting for streaming data...</p>
            )}
          </div>

          {/* Portfolio Allocation — current vs target */}
          {(() => {
            const totalPortfolioValue = portfolioValue || summary?.totalValue || 0;
            if (totalPortfolioValue <= 0) return null;

            const betaMap = new Map(positionBetas.map(b => [b.symbol, b]));

            // Build inputs for shared allocation function
            const allocInputs = positions.map(pos => {
              const security = securityMap.get(pos.securityId);
              if (!security) return null;
              const intent = intents.get(pos.id);
              const quote = streamingQuotes.get(security.symbol);
              const price = quote?.last || (pos.marketValue && pos.quantity > 0 ? pos.marketValue / pos.quantity : 0);
              return {
                symbol: security.symbol,
                quantity: pos.quantity,
                price,
                securityType: security.type as 'stock' | 'etf' | 'mutual_fund' | 'bond' | 'option' | 'crypto' | 'cash' | 'other',
                targetAllocationPct: intent?.targetAllocationPct ?? null,
                tier: intent?.tier || 'Untagged',
                accountId: pos.accountId,
              };
            }).filter((p): p is NonNullable<typeof p> => p !== null);

            const allocRows = calculateAllocationDrift({ positions: allocInputs });

            // Re-sort for dashboard display: targets by target desc, then no-target by current desc, cash last
            const withTargets = allocRows.filter(r => r.targetPct != null && r.targetPct > 0 && r.symbol !== 'Cash');
            const zeroOrNoTarget = allocRows.filter(r => (r.targetPct == null || r.targetPct === 0) && r.symbol !== 'Cash');
            const cashRow = allocRows.find(r => r.symbol === 'Cash');
            withTargets.sort((a, b) => (b.targetPct || 0) - (a.targetPct || 0));
            zeroOrNoTarget.sort((a, b) => b.currentPct - a.currentPct);
            const sorted = [...withTargets, ...zeroOrNoTarget, ...(cashRow ? [cashRow] : [])];

            const totalCurrentPct = sorted.reduce((s, r) => s + r.currentPct, 0);
            const totalTargetPct = sorted.reduce((s, r) => s + (r.targetPct || 0), 0);
            const totalMV = sorted.reduce((s, r) => s + r.marketValue, 0);
            const totalWeightedBeta = sorted.reduce((s, r) => {
              const b = betaMap.get(r.symbol);
              return s + (b ? b.beta * (r.currentPct / 100) : 0);
            }, 0);
            const totalTargetBeta = sorted.reduce((s, r) => {
              const b = betaMap.get(r.symbol);
              return s + (b && r.targetPct != null ? b.beta * (r.targetPct / 100) : 0);
            }, 0);

            return (
              <div className="card">
                <h2 className="text-lg font-semibold text-gray-900 mb-3">Portfolio Allocation</h2>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 border-b border-gray-200">
                      <th className="text-left py-1.5 font-medium">Ticker</th>
                      <th className="text-right py-1.5 font-medium">Current %</th>
                      <th className="text-right py-1.5 font-medium">Target %</th>
                      <th className="text-right py-1.5 font-medium">Current MV</th>
                      <th className="text-right py-1.5 font-medium">Wtd Beta</th>
                      <th className="text-right py-1.5 font-medium">Tgt Beta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map(a => {
                      const absDrift = Math.abs(a.driftPct ?? 0);
                      const tierColor = a.symbol === 'Cash' ? '#6b7280' : (TIER_COLORS[a.tier] || '#9ca3af');
                      const driftColor = a.targetPct == null ? 'text-gray-600'
                        : absDrift > 3 ? 'text-red-600'
                        : absDrift > 1 ? 'text-amber-600'
                        : 'text-gray-600';
                      return (
                        <tr key={a.symbol} className="border-b border-gray-100 hover:bg-gray-50">
                          <td className="py-1.5">
                            <div className="flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: tierColor }} title={a.tier} />
                              <span className="font-medium text-gray-900">{a.symbol}</span>
                            </div>
                          </td>
                          <td className={`text-right py-1.5 tabular-nums ${driftColor}`}>
                            {a.currentPct.toFixed(1)}%
                          </td>
                          <td className="text-right py-1.5 tabular-nums text-gray-600">
                            {a.targetPct != null ? `${a.targetPct.toFixed(1)}%` : '—'}
                          </td>
                          <td className="text-right py-1.5 tabular-nums text-gray-600">
                            {formatCurrency(a.marketValue)}
                          </td>
                          <td className="text-right py-1.5 tabular-nums text-gray-500">
                            {(() => {
                              const b = betaMap.get(a.symbol);
                              if (!b || a.symbol === 'Cash') return '—';
                              const wb = b.beta * (a.currentPct / 100);
                              return wb.toFixed(2);
                            })()}
                          </td>
                          <td className="text-right py-1.5 tabular-nums text-gray-500">
                            {(() => {
                              const b = betaMap.get(a.symbol);
                              if (!b || a.symbol === 'Cash' || a.targetPct == null) return '—';
                              const tb = b.beta * (a.targetPct / 100);
                              return tb.toFixed(2);
                            })()}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-gray-300 font-semibold text-gray-900">
                      <td className="py-2">Total</td>
                      <td className="text-right py-2 tabular-nums">{totalCurrentPct.toFixed(1)}%</td>
                      <td className="text-right py-2 tabular-nums text-gray-500">{totalTargetPct.toFixed(1)}%</td>
                      <td className="text-right py-2 tabular-nums">{formatCurrency(totalMV)}</td>
                      <td className="text-right py-2 tabular-nums">{totalWeightedBeta.toFixed(2)}</td>
                      <td className="text-right py-2 tabular-nums">{totalTargetBeta.toFixed(2)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            );
          })()}

          {/* Upcoming Earnings */}
          {earnings.length > 0 && (
            <div className="card">
              <h2 className="text-lg font-semibold text-gray-900 mb-3">Upcoming Earnings</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-2 px-3 font-medium text-gray-500">Date</th>
                      <th className="text-left py-2 px-3 font-medium text-gray-500">Symbol</th>
                      <th className="text-left py-2 px-3 font-medium text-gray-500">Time</th>
                      <th className="text-right py-2 px-3 font-medium text-gray-500">EPS Est.</th>
                      <th className="text-right py-2 px-3 font-medium text-gray-500">Rev Est.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {earnings.map((e, i) => {
                      const isToday = e.date === format(new Date(), 'yyyy-MM-dd');
                      const timeLabel = e.time === 'bmo' ? 'Pre-market' : e.time === 'amc' ? 'After-close' : e.time === 'dmh' ? 'During hours' : '';
                      return (
                        <tr key={`${e.symbol}-${i}`} className={`border-b border-gray-100 ${isToday ? 'bg-yellow-50' : 'hover:bg-gray-50'}`}>
                          <td className="py-2 px-3 text-gray-700">
                            {format(new Date(e.date + 'T12:00:00'), 'EEE, MMM d')}
                            {isToday && <span className="ml-1 text-xs font-medium text-yellow-700">TODAY</span>}
                          </td>
                          <td className="py-2 px-3 font-medium text-gray-900">{e.symbol}</td>
                          <td className="py-2 px-3 text-gray-500">{timeLabel}</td>
                          <td className="py-2 px-3 text-right text-gray-700">
                            {e.epsEstimated != null ? `$${e.epsEstimated.toFixed(2)}` : '-'}
                          </td>
                          <td className="py-2 px-3 text-right text-gray-700">
                            {e.revenueEstimated != null ? `$${(e.revenueEstimated / 1e9).toFixed(2)}B` : '-'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Recent News */}
          {newsArticles.length > 0 && (
            <div className="card">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold text-gray-900">Recent News</h2>
                <div className="flex gap-1">
                  {(['all', 'positions', 'watchlist'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setNewsTab(tab)}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                        newsTab === tab
                          ? 'bg-blue-100 text-blue-700'
                          : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                      }`}
                    >
                      {tab === 'all' ? 'All' : tab === 'positions' ? 'Positions' : 'Watchlist'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {(() => {
                  // Group by symbol, show top 3 per symbol
                  const grouped = new Map<string, NewsArticle[]>();
                  for (const a of filteredNews) {
                    const list = grouped.get(a.symbol) || [];
                    list.push(a);
                    grouped.set(a.symbol, list);
                  }
                  // Sort symbols by number of articles descending
                  const symbols = Array.from(grouped.keys()).sort((a, b) => (grouped.get(b)?.length || 0) - (grouped.get(a)?.length || 0));
                  if (symbols.length === 0) return <p className="text-sm text-gray-400">No news for this filter.</p>;
                  return symbols.map(sym => (
                    <div key={sym}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-semibold text-gray-900">{sym}</span>
                        <span className="text-xs text-gray-400">({grouped.get(sym)!.length})</span>
                      </div>
                      <div className="space-y-1 ml-2">
                        {grouped.get(sym)!.slice(0, 3).map((article, i) => (
                          <div key={i} className="flex items-start gap-2">
                            <span className="text-xs text-gray-400 whitespace-nowrap mt-0.5">
                              {format(new Date(article.publishedAt), 'h:mm a')}
                            </span>
                            {article.url ? (
                              <a
                                href={article.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-blue-600 hover:underline leading-tight"
                              >
                                {article.title}
                              </a>
                            ) : (
                              <span className="text-xs text-gray-700 leading-tight">{article.title}</span>
                            )}
                            {article.source && (
                              <span className="text-xs text-gray-400 whitespace-nowrap">[{article.source}]</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ));
                })()}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
