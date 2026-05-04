import { useEffect, useState, useMemo, useCallback } from 'react';
import { usePortfolio, usePositions, useSecurities, useSettings, usePositionIntents, useDailyRituals, useNews, useEarnings, useAnalytics, useEmsBaskets } from '../hooks/useApi';
import { useStreamingQuotes } from '../hooks/useStreamingQuotes';
import type { StreamingQuote, NewsArticle, EarningsEvent } from '../../shared/types';
import { calculateAllocationDrift, type AllocationRow } from '../../shared/analytics/allocation';
import { format, addDays } from 'date-fns';
import ChartModal from '../components/ChartModal';

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
  const { baskets, activeBasket, loading: basketLoading, fetchBaskets, fetchBasket, resizeBasket } = useEmsBaskets();
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [expandedTranches, setExpandedTranches] = useState<Set<string>>(new Set());
  const [expandAllTranches, setExpandAllTranches] = useState(false);
  const [sectorData, setSectorData] = useState<Array<{ symbol: string; name: string; changePct: number; price: number }>>([]);
  const [sectorBenchmark, setSectorBenchmark] = useState<{ symbol: string; changePct: number; price: number } | null>(null);
  const [sectorDate, setSectorDate] = useState<string>('');
  const [regimeLoading, setRegimeLoading] = useState(false);
  const [regimeSignals, setRegimeSignals] = useState<{
    type: 'trend' | 'sorting';
    confidence: number;
    summary: string;
    sectorSignals: Array<{
      symbol: string; sector: string; changePct: number;
      indexCorrelation: number; autocorrelation: number; quadrant: string;
    }>;
  } | null>(null);
  const [showRegimeDetail, setShowRegimeDetail] = useState(false);
  const [newsTab, setNewsTab] = useState<'all' | 'positions' | 'watchlist'>('all');
  const [watchlistSymbols, setWatchlistSymbols] = useState<string[]>([]);
  const [earningsDays, setEarningsDays] = useState<number>(14);
  const [chartSymbol, setChartSymbol] = useState<{ symbol: string; name?: string } | null>(null);

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
    const endDate = format(addDays(new Date(), earningsDays), 'yyyy-MM-dd');
    fetchPortfolioEarnings(today, endDate);
    window.electronAPI.getWatchlistSymbols().then(setWatchlistSymbols).catch(() => {});
    fetchBaskets();
  }, [fetchSummary, fetchPositions, fetchSecurities, fetchSettings, fetchIntents, fetchRituals, fetchRecentNews, fetchAnalytics, fetchPortfolioEarnings, fetchBaskets, earningsDays]);

  // Auto-load first active basket
  useEffect(() => {
    const active = baskets.find(b => b.status === 'active');
    if (active && (!activeBasket || activeBasket.name !== active.name)) {
      fetchBasket(active.name);
    }
  }, [baskets, activeBasket, fetchBasket]);

  // Listen for position sync events
  useEffect(() => {
    const removeListener = window.electronAPI.onPositionsSynced(() => {
      setLastSynced(new Date());
      fetchPositions();
      fetchSummary();
    });
    return () => removeListener();
  }, [fetchPositions, fetchSummary]);

  // Fetch sector data from local ETF prices
  const fetchSectorData = useCallback(() => {
    window.electronAPI.getSectorPerformance().then((result) => {
      if (result) {
        setSectorData(result.sectors);
        setSectorBenchmark(result.benchmark);
        setSectorDate(result.date);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetchSectorData();
    // Refresh sector data every 60s to match polling interval
    const interval = setInterval(fetchSectorData, 60000);
    return () => clearInterval(interval);
  }, [fetchSectorData]);

  const handleReadRegime = useCallback(async () => {
    setRegimeLoading(true);
    try {
      const result = await window.electronAPI.readRegime();
      if (result.error) {
        console.error('Read regime error:', result.error);
      } else {
        if (result.regime) setRegimeSignals(result.regime);
        fetchRituals(1);
      }
    } catch (err) {
      console.error('Read regime failed:', err);
    } finally {
      setRegimeLoading(false);
    }
  }, [fetchRituals]);

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
  const { quotes: streamingQuotes, status: streamingStatus } = useStreamingQuotes(symbolList);

  // Last quote timestamp — tracks freshness
  const [lastQuoteAge, setLastQuoteAge] = useState<string>('');
  const lastQuoteTs = useMemo(() => {
    let max = 0;
    for (const [, q] of streamingQuotes) {
      if (q.timestamp > max) max = q.timestamp;
    }
    return max;
  }, [streamingQuotes]);

  useEffect(() => {
    const update = () => {
      if (lastQuoteTs === 0) { setLastQuoteAge(''); return; }
      const secs = Math.floor((Date.now() - lastQuoteTs) / 1000);
      if (secs < 10) setLastQuoteAge('just now');
      else if (secs < 60) setLastQuoteAge(`${secs}s ago`);
      else if (secs < 3600) setLastQuoteAge(`${Math.floor(secs / 60)}m ago`);
      else setLastQuoteAge(`${Math.floor(secs / 3600)}h ago`);
    };
    update();
    const interval = setInterval(update, 5000);
    return () => clearInterval(interval);
  }, [lastQuoteTs]);

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
          {(() => {
            const quoteFresh = lastQuoteTs > 0 && (Date.now() - lastQuoteTs) < 15000;
            const isLive = streamingStatus === 'connected' || (streamingStatus === 'outside_hours' && quoteFresh);
            const isStale = lastQuoteTs > 0 && (Date.now() - lastQuoteTs) > 30000;
            return (
              <div className="flex items-center gap-1.5" title={`${streamingStatus}${lastQuoteAge ? ` · ${lastQuoteAge}` : ''}`}>
                <span className={`w-2 h-2 rounded-full ${
                  isStale ? 'bg-red-500' :
                  isLive ? 'bg-green-500 animate-pulse' :
                  streamingStatus === 'connecting' ? 'bg-yellow-400 animate-pulse' :
                  streamingStatus === 'error' ? 'bg-red-500' :
                  'bg-gray-400'
                }`} />
                <span className="text-xs text-gray-400">
                  {isStale ? 'Stale' :
                   isLive ? 'Live' :
                   streamingStatus === 'connecting' ? 'Connecting...' :
                   streamingStatus === 'error' ? 'Error' :
                   'Offline'}
                  {lastQuoteAge && ` · ${lastQuoteAge}`}
                </span>
              </div>
            );
          })()}
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
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-gray-900">Today's Regime</h2>
              <button
                onClick={handleReadRegime}
                disabled={regimeLoading}
                className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs hover:bg-blue-700 disabled:opacity-50"
                title="Auto-detect rewarding/punishing sectors from ETF price data"
              >
                {regimeLoading ? 'Reading...' : 'Read Regime'}
              </button>
            </div>
            {todayRitual && (todayRitual.regimeRewarding || todayRitual.regimePunishing) ? (
              <div className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <span className="text-xs font-medium text-gray-500 uppercase">Type</span>
                    <div className="mt-1">
                      {todayRitual.regimeType === 'trend' ? (
                        <span className="inline-flex items-center px-2.5 py-1 rounded-md text-sm font-medium bg-blue-100 text-blue-800">
                          Trend Day{regimeSignals ? ` (${Math.round(regimeSignals.confidence * 100)}%)` : ''}
                        </span>
                      ) : todayRitual.regimeType === 'sorting' ? (
                        <span className="inline-flex items-center px-2.5 py-1 rounded-md text-sm font-medium bg-amber-100 text-amber-800">
                          Sorting Day{regimeSignals ? ` (${Math.round(regimeSignals.confidence * 100)}%)` : ''}
                        </span>
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
                {regimeSignals && (
                  <div className="border-t border-gray-100 pt-2">
                    <p className="text-xs text-gray-500">{regimeSignals.summary}</p>
                    <button
                      onClick={() => setShowRegimeDetail(!showRegimeDetail)}
                      className="text-xs text-blue-600 hover:underline mt-1"
                    >
                      {showRegimeDetail ? 'Hide details' : 'Show sector details'}
                    </button>
                    {showRegimeDetail && (
                      <div className="mt-2 overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-gray-200">
                              <th className="text-left py-1 pr-2 font-medium text-gray-500">Sector</th>
                              <th className="text-right py-1 px-2 font-medium text-gray-500">ETF</th>
                              <th className="text-right py-1 px-2 font-medium text-gray-500">Chg%</th>
                              <th className="text-right py-1 px-2 font-medium text-gray-500">SPY Corr</th>
                              <th className="text-right py-1 px-2 font-medium text-gray-500">AutoCorr</th>
                              <th className="text-left py-1 pl-2 font-medium text-gray-500">Signal</th>
                            </tr>
                          </thead>
                          <tbody>
                            {regimeSignals.sectorSignals.map(s => (
                              <tr key={s.symbol} className="border-b border-gray-50">
                                <td className="py-1 pr-2 text-gray-700">{s.sector}</td>
                                <td className="py-1 px-2 text-right text-gray-500">{s.symbol}</td>
                                <td className={`py-1 px-2 text-right font-medium ${s.changePct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                  {s.changePct >= 0 ? '+' : ''}{s.changePct.toFixed(2)}%
                                </td>
                                <td className="py-1 px-2 text-right text-gray-600">{s.indexCorrelation.toFixed(2)}</td>
                                <td className="py-1 px-2 text-right text-gray-600">{s.autocorrelation.toFixed(2)}</td>
                                <td className="py-1 pl-2">
                                  <span className={`px-1.5 py-0.5 rounded text-xs ${
                                    s.quadrant === 'trend-momentum' ? 'bg-green-100 text-green-700' :
                                    s.quadrant === 'risk-toggle' ? 'bg-blue-100 text-blue-700' :
                                    s.quadrant === 'sector-rotation' ? 'bg-amber-100 text-amber-700' :
                                    'bg-gray-100 text-gray-600'
                                  }`}>
                                    {s.quadrant}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
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

            {/* Market Sector Heatmap — from local ETF prices */}
            <div className="card">
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-lg font-semibold text-gray-900">Market Sectors</h2>
                {sectorDate && <span className="text-xs text-gray-400">{sectorDate}</span>}
              </div>
              {sectorBenchmark && (
                <p className="text-xs text-gray-500 mb-3">
                  SPY ${sectorBenchmark.price.toFixed(2)}{' '}
                  <span className={sectorBenchmark.changePct >= 0 ? 'text-green-600' : 'text-red-600'}>
                    {sectorBenchmark.changePct >= 0 ? '+' : ''}{sectorBenchmark.changePct.toFixed(2)}%
                  </span>
                </p>
              )}
              {sectorData.length > 0 ? (
                <div className="space-y-1.5">
                  {sectorData.map(s => {
                    const isPositive = s.changePct >= 0;
                    const barWidth = Math.min(Math.abs(s.changePct) * 15, 100);
                    return (
                      <div key={s.symbol} className="flex items-center gap-2">
                        <span className="text-xs w-36 truncate text-gray-600">{s.name}</span>
                        <span className="text-xs w-10 text-right text-gray-400">{s.symbol}</span>
                        <div className="flex-1 flex items-center">
                          <div className="w-full h-4 bg-gray-50 rounded relative overflow-hidden">
                            <div
                              className={`h-full rounded ${isPositive ? 'bg-green-400' : 'bg-red-400'}`}
                              style={{ width: `${barWidth}%`, opacity: 0.7 }}
                            />
                          </div>
                        </div>
                        <span className={`text-xs font-medium w-14 text-right ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
                          {isPositive ? '+' : ''}{s.changePct.toFixed(2)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-gray-400">No sector data — run refresh first</p>
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

            // Build tranche map: symbol → pending/triggered tranches from active basket
            const tranchesBySymbol = new Map<string, Array<{
              side: string; shares: number; status: string;
              triggerType?: string; triggerDate?: string | null; triggerPrice?: number;
            }>>();
            if (activeBasket?.plans) {
              for (const plan of activeBasket.plans) {
                const sym = plan.symbol || '?';
                for (const t of (plan.tranches || [])) {
                  if (t.status === 'filled' || t.status === 'cancelled') continue;
                  if (!tranchesBySymbol.has(sym)) tranchesBySymbol.set(sym, []);
                  tranchesBySymbol.get(sym)!.push({
                    side: plan.side || 'buy',
                    shares: t.shares,
                    status: t.status,
                    triggerType: t.triggerType,
                    triggerDate: t.triggerDate,
                    triggerPrice: t.triggerPrice,
                  });
                }
              }
              for (const [, tranches] of tranchesBySymbol) {
                tranches.sort((a, b) => {
                  if (a.triggerDate && b.triggerDate) return a.triggerDate.localeCompare(b.triggerDate);
                  return 0;
                });
              }
            }

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
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-lg font-semibold text-gray-900">Portfolio Allocation</h2>
                  <div className="flex items-center gap-3">
                    {activeBasket && (
                      <button
                        onClick={async () => {
                          await resizeBasket(activeBasket.name);
                          fetchBasket(activeBasket.name);
                        }}
                        disabled={basketLoading}
                        className="px-3 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-50"
                        title="Recalculate EMS tranche quantities from target allocations"
                      >
                        {basketLoading ? 'Resizing...' : 'Resize Tranches'}
                      </button>
                    )}
                    {tranchesBySymbol.size > 0 && (
                      <button
                        onClick={() => {
                          setExpandAllTranches(!expandAllTranches);
                          if (!expandAllTranches) {
                            setExpandedTranches(new Set(Array.from(tranchesBySymbol.keys())));
                          } else {
                            setExpandedTranches(new Set());
                          }
                        }}
                        className="text-xs text-blue-600 hover:underline"
                      >
                        {expandAllTranches ? 'Collapse tranches' : 'Show scheduled tranches'}
                      </button>
                    )}
                  </div>
                </div>
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
                    {sorted.flatMap(a => {
                      const absDrift = Math.abs(a.driftPct ?? 0);
                      const tierColor = a.symbol === 'Cash' ? '#6b7280' : (TIER_COLORS[a.tier] || '#9ca3af');
                      const driftColor = a.targetPct == null ? 'text-gray-600'
                        : absDrift > 3 ? 'text-red-600'
                        : absDrift > 1 ? 'text-amber-600'
                        : 'text-gray-600';
                      const symbolTranches = tranchesBySymbol.get(a.symbol);
                      const isExpanded = expandedTranches.has(a.symbol);
                      const hasTranches = symbolTranches && symbolTranches.length > 0;
                      const totalScheduled = symbolTranches?.reduce((s, t) => {
                        const sign = t.side === 'sell' ? -1 : 1;
                        return s + (t.shares * sign);
                      }, 0) || 0;

                      const rows = [(
                        <tr
                          key={a.symbol}
                          className={`border-b border-gray-100 hover:bg-gray-50 ${hasTranches ? 'cursor-pointer' : ''}`}
                          onClick={() => {
                            if (!hasTranches) return;
                            const next = new Set(expandedTranches);
                            if (isExpanded) next.delete(a.symbol); else next.add(a.symbol);
                            setExpandedTranches(next);
                          }}
                        >
                          <td className="py-1.5">
                            <div className="flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: tierColor }} title={a.tier} />
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const position = positions.find(p => {
                                    const sec = securityMap.get(p.securityId);
                                    return sec?.symbol === a.symbol;
                                  });
                                  const security = position ? securityMap.get(position.securityId) : null;
                                  setChartSymbol({ symbol: a.symbol, name: security?.name });
                                }}
                                className="font-medium text-blue-600 hover:text-blue-800 hover:underline"
                              >
                                {a.symbol}
                              </button>
                              {hasTranches && (
                                <span className="text-xs text-blue-500" title={`${totalScheduled} shares scheduled`}>
                                  {isExpanded ? '▾' : '▸'} {totalScheduled >= 0 ? '+' : ''}{totalScheduled}
                                </span>
                              )}
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
                      )];

                      if (isExpanded && symbolTranches) {
                        for (let ti = 0; ti < symbolTranches.length; ti++) {
                          const t = symbolTranches[ti];
                          rows.push(
                            <tr key={`${a.symbol}-t-${ti}`} className="bg-blue-50/50 border-b border-blue-100/50">
                              <td className="py-1 pl-8 text-xs text-gray-500" colSpan={2}>
                                <span className={t.side === 'sell' ? 'text-red-500' : 'text-green-600'}>{t.side.toUpperCase()}</span>
                                {' '}{t.shares} shares
                                {' · '}
                                {t.triggerType === 'date' ? (t.triggerDate || 'date TBD') : `@ $${t.triggerPrice?.toFixed(2) || '?'}`}
                              </td>
                              <td className="py-1 text-xs text-right text-gray-400" colSpan={4}>
                                <span className={`px-1.5 py-0.5 rounded ${
                                  t.status === 'triggered' ? 'bg-yellow-100 text-yellow-700' :
                                  t.status === 'submitted' ? 'bg-blue-100 text-blue-700' :
                                  'bg-gray-100 text-gray-500'
                                }`}>{t.status}</span>
                              </td>
                            </tr>
                          );
                        }
                      }
                      return rows;
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
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-gray-900">Upcoming Earnings</h2>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500">Next</label>
                <select
                  value={earningsDays}
                  onChange={(e) => setEarningsDays(Number(e.target.value))}
                  className="px-2 py-1 text-xs border border-gray-300 rounded-md bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value={7}>7 days</option>
                  <option value={14}>14 days</option>
                  <option value={30}>30 days</option>
                  <option value={60}>60 days</option>
                  <option value={90}>90 days</option>
                </select>
              </div>
            </div>
            {earnings.length > 0 ? (
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
            ) : (
              <p className="text-sm text-gray-400">No earnings scheduled in the next {earningsDays} days.</p>
            )}
          </div>

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

      {chartSymbol && (
        <ChartModal
          symbol={chartSymbol.symbol}
          name={chartSymbol.name}
          onClose={() => setChartSymbol(null)}
        />
      )}
    </div>
  );
}
