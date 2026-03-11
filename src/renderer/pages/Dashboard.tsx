import { useEffect, useState, useMemo, useCallback } from 'react';
import { usePortfolio, usePositions, useSecurities, useSettings, usePositionIntents, useDailyRituals } from '../hooks/useApi';
import { useStreamingQuotes } from '../hooks/useStreamingQuotes';
import type { StreamingQuote } from '../../shared/types';
import { format } from 'date-fns';

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
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [rawSectorData, setRawSectorData] = useState<{ nyse: Record<string, number>; nasdaq: Record<string, number> } | null>(null);
  const [sectorDate, setSectorDate] = useState<string>('');
  const [sectorView, setSectorView] = useState<'all' | 'nyse' | 'nasdaq'>('all');

  useEffect(() => {
    fetchSummary();
    fetchPositions();
    fetchSecurities();
    fetchSettings();
    fetchIntents();
    fetchRituals(1);
  }, [fetchSummary, fetchPositions, fetchSecurities, fetchSettings, fetchIntents, fetchRituals]);

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

  // Portfolio day performance from streaming data
  const portfolioDayChange = useMemo(() => {
    let totalChange = 0;
    const seen = new Set<string>();
    for (const pos of positions) {
      const security = securityMap.get(pos.securityId);
      if (!security || security.type === 'cash') continue;
      const quote = streamingQuotes.get(security.symbol);
      if (!quote?.netChange) continue;
      // Each position contributes its own quantity * price change
      totalChange += (quote.netChange || 0) * pos.quantity;
    }
    return totalChange;
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
    return movers.slice(0, 8);
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
              <p className="stat-value">{formatCurrency(summary?.totalValue || 0)}</p>
              {portfolioDayChange !== 0 ? (
                <p className={`text-sm font-medium ${portfolioDayChange >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {portfolioDayChange >= 0 ? '+' : ''}{formatCurrency(portfolioDayChange)} ({((portfolioDayChange / ((summary?.totalValue || 0) - portfolioDayChange)) * 100).toFixed(2)}%) today
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
        </>
      )}
    </div>
  );
}
