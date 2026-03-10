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
  const [sectorData, setSectorData] = useState<{ sector: string; change: number }[]>([]);
  const [sectorDate, setSectorDate] = useState<string>('');
  const [fmpKey, setFmpKey] = useState<string | null>(null);

  useEffect(() => {
    fetchSummary();
    fetchPositions();
    fetchSecurities();
    fetchSettings();
    fetchIntents();
    fetchRituals(1);
    window.electronAPI.getFmpApiKey().then(setFmpKey);
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

  // Fetch sector data from FMP
  useEffect(() => {
    const fetchSectors = async () => {
      try {
        if (!fmpKey) return;

        const today = format(new Date(), 'yyyy-MM-dd');
        // Try today, then previous days
        for (let i = 0; i < 4; i++) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const dateStr = format(d, 'yyyy-MM-dd');
          const resp = await fetch(`https://financialmodelingprep.com/stable/sector-performance-snapshot?date=${dateStr}&apikey=${fmpKey}`);
          const data = await resp.json();
          if (data && data.length > 0) {
            // Aggregate across exchanges
            const sectors: Record<string, number[]> = {};
            for (const row of data) {
              if (!sectors[row.sector]) sectors[row.sector] = [];
              sectors[row.sector].push(row.averageChange);
            }
            const averaged = Object.entries(sectors)
              .map(([sector, vals]) => ({ sector, change: vals.reduce((a, b) => a + b, 0) / vals.length }))
              .sort((a, b) => b.change - a.change);
            setSectorData(averaged);
            setSectorDate(dateStr === today ? 'Today' : dateStr);
            break;
          }
        }
      } catch {
        // Silently fail
      }
    };
    if (fmpKey) {
      fetchSectors();
    }
  }, [fmpKey]);

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
                  {portfolioDayChange >= 0 ? '+' : ''}{formatCurrency(portfolioDayChange)} today
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

            {/* Sector Heatmap */}
            <div className="card">
              <h2 className="text-lg font-semibold text-gray-900 mb-1">Sector Performance</h2>
              {sectorDate && <p className="text-xs text-gray-400 mb-3">{sectorDate}</p>}
              {sectorData.length > 0 ? (
                <div className="space-y-1.5">
                  {sectorData.map(s => {
                    const isPositive = s.change >= 0;
                    const barWidth = Math.min(Math.abs(s.change) * 15, 100);
                    return (
                      <div key={s.sector} className="flex items-center gap-2">
                        <span className="text-xs w-36 truncate text-gray-600">{s.sector}</span>
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
        </>
      )}
    </div>
  );
}
