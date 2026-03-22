import { useEffect, useState, useMemo } from 'react';
import { useAnalytics, useTransactions, useAccounts, useSecurities, useTradeAnalytics, useTradeJournal, useValuationMetrics, usePositions, usePositionIntents, usePriceLevels, useWatchlists, useTrendIndicators, useEarnings } from '../hooks/useApi';
import type { PortfolioAnalytics, PositionBeta, Transaction, Security, TradeJournalEntry, ValuationMetric, Position, PositionIntent, PriceLevel, WatchlistItem, TrendIndicator, EarningsEvent } from '../../shared/types';
import { format } from 'date-fns';
import TransactionImportModal from '../components/TransactionImportModal';

const PERIODS = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '180d', days: 180 },
  { label: '1Y', days: 365 },
];

const transactionTypes = [
  { value: 'buy', label: 'Buy' },
  { value: 'sell', label: 'Sell' },
  { value: 'dividend', label: 'Dividend' },
  { value: 'interest', label: 'Interest' },
  { value: 'transfer_in', label: 'Transfer In' },
  { value: 'transfer_out', label: 'Transfer Out' },
  { value: 'split', label: 'Stock Split' },
  { value: 'spinoff', label: 'Spinoff' },
  { value: 'fee', label: 'Fee' },
];

function betaColor(beta: number): string {
  if (beta >= 1.5) return 'text-red-600';
  if (beta >= 1.2) return 'text-yellow-600';
  if (beta < 0.8) return 'text-blue-600';
  return 'text-gray-900';
}

function drawdownColor(dd: number): string {
  const abs = Math.abs(dd);
  if (abs >= 20) return 'text-red-600';
  if (abs >= 10) return 'text-yellow-600';
  return 'text-gray-900';
}

function sharpeColor(sr: number): string {
  if (sr < 0) return 'text-red-600';
  if (sr >= 2) return 'text-green-700';
  if (sr >= 1) return 'text-green-600';
  return 'text-gray-900';
}

function returnColor(val: number): string {
  return val >= 0 ? 'text-green-600' : 'text-red-600';
}

function formatPct(val: number, digits = 2): string {
  return `${val >= 0 ? '+' : ''}${val.toFixed(digits)}%`;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function getTypeColor(type: Transaction['type']): string {
  switch (type) {
    case 'buy': case 'transfer_in': return 'badge-success';
    case 'sell': case 'transfer_out': return 'badge-error';
    case 'dividend': case 'interest': return 'badge-info';
    default: return 'badge-warning';
  }
}

function CorrelationConcentrationSection({ period: _period }: { period: number }) {
  // Correlation needs a longer window than other analytics — 1Y minimum for statistical significance
  const corrPeriod = 365;
  const [corrData, setCorrData] = useState<{
    symbols: string[];
    matrix: number[][];
    highCorrelations: Array<{ symbolA: string; symbolB: string; correlation: number }>;
  } | null>(null);
  const [concData, setConcData] = useState<{
    sectorConcentration: Array<{ sector: string; weight: number; symbols: string[] }>;
    tierConcentration: Array<{ tier: string; weight: number; count: number }>;
    top5Weight: number;
    herfindahlIndex: number;
    effectivePositions: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [showHeatmap, setShowHeatmap] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      window.electronAPI.getCorrelationMatrix(corrPeriod),
      window.electronAPI.getConcentrationAnalysis(),
    ]).then(([corr, conc]) => {
      if (!cancelled) {
        setCorrData(corr);
        setConcData(conc);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [corrPeriod]);

  if (loading) {
    return <div className="card"><div className="text-center py-6 text-gray-400">Loading correlation & concentration...</div></div>;
  }

  return (
    <div className="space-y-4">
      {/* Concentration Metrics */}
      {concData && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="card">
              <p className="stat-label">Top 5 Weight</p>
              <p className={`stat-value ${concData.top5Weight > 60 ? 'text-red-600' : concData.top5Weight > 40 ? 'text-yellow-600' : 'text-gray-900'}`}>
                {concData.top5Weight.toFixed(1)}%
              </p>
            </div>
            <div className="card">
              <p className="stat-label">Effective Positions</p>
              <p className="stat-value">{concData.effectivePositions.toFixed(1)}</p>
              <p className="text-xs text-gray-400 mt-1">1/HHI diversification</p>
            </div>
            <div className="card">
              <p className="stat-label">HHI</p>
              <p className={`stat-value ${concData.herfindahlIndex > 1500 ? 'text-red-600' : concData.herfindahlIndex > 1000 ? 'text-yellow-600' : 'text-green-600'}`}>
                {concData.herfindahlIndex.toFixed(0)}
              </p>
              <p className="text-xs text-gray-400 mt-1">{concData.herfindahlIndex > 1500 ? 'concentrated' : concData.herfindahlIndex > 1000 ? 'moderate' : 'diversified'}</p>
            </div>
            <div className="card">
              <p className="stat-label">Sectors</p>
              <p className="stat-value">{concData.sectorConcentration.length}</p>
            </div>
          </div>

          {/* Sector & Tier Concentration side by side */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Sector Concentration</h3>
              <div className="space-y-2">
                {concData.sectorConcentration.map(s => (
                  <div key={s.sector}>
                    <div className="flex justify-between text-sm mb-0.5">
                      <span className="text-gray-700">{s.sector}</span>
                      <span className="font-medium text-gray-900">{s.weight.toFixed(1)}%</span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full ${s.weight > 30 ? 'bg-red-500' : s.weight > 20 ? 'bg-yellow-500' : 'bg-blue-500'}`}
                        style={{ width: `${Math.min(s.weight, 100)}%` }}
                      />
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">{s.symbols.join(', ')}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="card">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Tier Concentration</h3>
              <div className="space-y-2">
                {concData.tierConcentration.map(t => (
                  <div key={t.tier}>
                    <div className="flex justify-between text-sm mb-0.5">
                      <span className="text-gray-700">{t.tier} <span className="text-gray-400">({t.count})</span></span>
                      <span className="font-medium text-gray-900">{t.weight.toFixed(1)}%</span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-2">
                      <div
                        className="h-2 rounded-full bg-indigo-500"
                        style={{ width: `${Math.min(t.weight, 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {/* High Correlations */}
      {corrData && corrData.highCorrelations.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-900">High Correlations (|r| &ge; 0.7)</h3>
            {corrData.symbols.length > 0 && (
              <button
                onClick={() => setShowHeatmap(!showHeatmap)}
                className="text-xs text-blue-600 hover:text-blue-700"
              >
                {showHeatmap ? 'Hide heatmap' : 'Show heatmap'}
              </button>
            )}
          </div>
          <div className="space-y-1.5">
            {corrData.highCorrelations.map((hc, i) => {
              const abs = Math.abs(hc.correlation);
              return (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-sm font-medium text-gray-900 w-28">{hc.symbolA} / {hc.symbolB}</span>
                  <div className="flex-1 bg-gray-100 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full ${abs >= 0.9 ? 'bg-red-500' : abs >= 0.8 ? 'bg-orange-500' : 'bg-yellow-500'}`}
                      style={{ width: `${abs * 100}%` }}
                    />
                  </div>
                  <span className={`text-sm font-medium w-12 text-right ${abs >= 0.9 ? 'text-red-600' : abs >= 0.8 ? 'text-orange-600' : 'text-yellow-600'}`}>
                    {hc.correlation.toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Correlation Heatmap */}
      {showHeatmap && corrData && corrData.symbols.length > 0 && (
        <div className="card overflow-x-auto">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Correlation Matrix (1Y)</h3>
          <table className="text-xs">
            <thead>
              <tr>
                <th className="p-1"></th>
                {corrData.symbols.map(s => (
                  <th key={s} className="p-1 text-gray-500 font-medium" style={{ writingMode: 'vertical-rl', textOrientation: 'mixed', maxHeight: '80px' }}>{s}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {corrData.symbols.map((rowSym, ri) => (
                <tr key={rowSym}>
                  <td className="p-1 font-medium text-gray-700 pr-2">{rowSym}</td>
                  {corrData.symbols.map((_, ci) => {
                    const val = corrData.matrix[ri][ci];
                    const abs = Math.abs(val);
                    let bg = 'bg-gray-50';
                    if (ri === ci) bg = 'bg-gray-200';
                    else if (abs >= 0.9) bg = val > 0 ? 'bg-red-300' : 'bg-blue-300';
                    else if (abs >= 0.7) bg = val > 0 ? 'bg-red-200' : 'bg-blue-200';
                    else if (abs >= 0.5) bg = val > 0 ? 'bg-red-100' : 'bg-blue-100';
                    return (
                      <td key={ci} className={`p-1 text-center ${bg}`} title={`${rowSym} / ${corrData.symbols[ci]}: ${val.toFixed(2)}`}>
                        {ri !== ci ? val.toFixed(1) : ''}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* No correlations message */}
      {corrData && corrData.highCorrelations.length === 0 && corrData.symbols.length > 0 && (
        <div className="card">
          <p className="text-sm text-gray-500 text-center py-2">No highly correlated pairs found (all |r| &lt; 0.7)</p>
        </div>
      )}
    </div>
  );
}

// --- Valuation Section ---

type SortKey = 'symbol' | 'trailingPe' | 'forwardPe' | 'peg' | 'forwardEps' | 'epsGrowthPct' | 'pegRating';
type SortDir = 'asc' | 'desc';

function pegRatingBadge(rating: ValuationMetric['pegRating']) {
  if (!rating) return <span className="text-gray-400">—</span>;
  const styles: Record<string, string> = {
    CHEAP: 'bg-green-100 text-green-800',
    FAIR: 'bg-blue-100 text-blue-800',
    RICH: 'bg-amber-100 text-amber-800',
    PRICEY: 'bg-red-100 text-red-800',
  };
  return (
    <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full ${styles[rating] || 'bg-gray-100 text-gray-800'}`}>
      {rating}
    </span>
  );
}

function fmtNum(v: number | null, digits = 1): string {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return v.toFixed(digits);
}

interface ConfluenceData {
  positions: Position[];
  securities: Security[];
  intents: Map<string, PositionIntent>;
  priceLevels: PriceLevel[];
  watchlistItems: WatchlistItem[];
  trendIndicators: TrendIndicator[];
  punishedSectors: Set<string>;
  earningsEvents: EarningsEvent[];
}

const SECTOR_ALIASES: Record<string, string> = {
  'tech': 'Technology', 'technology': 'Technology',
  'comms': 'Communication Services', 'comm services': 'Communication Services',
  'communication': 'Communication Services', 'communication services': 'Communication Services',
  'consumer cyclical': 'Consumer Cyclical', 'cyclical': 'Consumer Cyclical',
  'consumer defensive': 'Consumer Defensive', 'defensive': 'Consumer Defensive',
  'defensives': 'Consumer Defensive',
  'financial': 'Financial Services', 'financial services': 'Financial Services',
  'financials': 'Financial Services',
  'healthcare': 'Healthcare', 'health': 'Healthcare',
  'industrials': 'Industrials', 'industrial': 'Industrials',
  'energy': 'Energy', 'oil': 'Energy',
  'utilities': 'Utilities', 'utility': 'Utilities',
  'basic materials': 'Basic Materials', 'materials': 'Basic Materials',
  'real estate': 'Real Estate',
};

function parsePunishedSectors(regimePunishing: string | null): Set<string> {
  if (!regimePunishing) return new Set();
  const text = regimePunishing.toLowerCase();
  const sectors = new Set<string>();
  for (const [alias, canonical] of Object.entries(SECTOR_ALIASES)) {
    if (text.includes(alias)) sectors.add(canonical);
  }
  return sectors;
}

function getSymbolSector(symbol: string, data: ConfluenceData): string | null {
  const sec = data.securities.find(s => s.symbol === symbol);
  return sec?.sector ?? null;
}

function classifyCandidate(
  symbol: string,
  v: ValuationMetric,
  data: ConfluenceData,
): { type: 'investing' | 'trading'; reason: string } {
  const secMap = new Map(data.securities.map(s => [s.id, s]));
  const pos = data.positions.find(p => secMap.get(p.securityId)?.symbol === symbol);
  if (pos) {
    const intent = data.intents.get(pos.id);
    const tier = intent?.tier || 'unknown';
    const targetPct = intent?.targetAllocationPct;
    const curPct = pos.marketValue && data.positions.reduce((sum, p) => sum + (p.marketValue || 0), 0) > 0
      ? (pos.marketValue / data.positions.reduce((sum, p) => sum + (p.marketValue || 0), 0)) * 100
      : null;
    const underAlloc = targetPct && curPct && curPct < targetPct;
    return {
      type: 'investing',
      reason: `${tier} position${underAlloc ? `, under-allocated (${curPct.toFixed(1)}% vs ${targetPct.toFixed(1)}% target)` : ''}`,
    };
  }
  const wlItem = data.watchlistItems.find(w => w.symbol === symbol);
  if (wlItem && v.forwardPeg !== null && v.forwardPeg < 1.5) {
    return { type: 'investing', reason: `On watchlist — ${wlItem.thesisSnippet || 'no thesis'}` };
  }
  return { type: 'trading', reason: 'Not held, potential trade setup' };
}

function buildWhyNow(
  symbol: string,
  v: ValuationMetric,
  data: ConfluenceData,
): string[] {
  const bullets: string[] = [];
  // Valuation
  if (v.pegRating && v.forwardPeg !== null) {
    const interp: Record<string, string> = {
      CHEAP: 'undervalued relative to growth',
      FAIR: 'paying roughly in line with growth',
      RICH: 'premium to growth rate',
      PRICEY: 'significant premium to growth',
    };
    bullets.push(`PEG ${v.forwardPeg.toFixed(2)} (${v.pegRating}) — ${interp[v.pegRating] || ''}`);
  }
  // S/R proximity
  const supports = data.priceLevels
    .filter(l => l.symbol === symbol && l.levelType === 'support')
    .sort((a, b) => b.price - a.price);
  if (supports.length > 0) {
    const top = supports[0];
    bullets.push(`Near support $${top.price.toFixed(0)} (strength ${top.strength}/10)`);
  }
  // EPS growth
  if (v.epsGrowthPct !== null) {
    const trend = v.epsGrowthPct > 30 ? 'strong' : v.epsGrowthPct > 15 ? 'moderate' : 'steady';
    bullets.push(`EPS growth +${v.epsGrowthPct.toFixed(0)}% — ${trend}`);
  }
  // Forward PE
  if (v.forwardPe !== null) {
    bullets.push(`Forward PE ${v.forwardPe.toFixed(1)}x`);
  }
  // Allocation gap
  const secMap = new Map(data.securities.map(s => [s.id, s]));
  const pos = data.positions.find(p => secMap.get(p.securityId)?.symbol === symbol);
  if (pos) {
    const intent = data.intents.get(pos.id);
    const totalMV = data.positions.reduce((sum, p) => sum + (p.marketValue || 0), 0);
    if (intent?.targetAllocationPct && pos.marketValue && totalMV > 0) {
      const curPct = (pos.marketValue / totalMV) * 100;
      if (curPct < intent.targetAllocationPct) {
        bullets.push(`Under-allocated: ${curPct.toFixed(1)}% vs ${intent.targetAllocationPct.toFixed(1)}% target`);
      }
    }
  }
  // Watchlist
  const wlItem = data.watchlistItems.find(w => w.symbol === symbol);
  if (wlItem && wlItem.thesisSnippet) {
    bullets.push(`On watchlist — ${wlItem.thesisSnippet}`);
  }
  return bullets;
}

function buildRisks(
  symbol: string,
  v: ValuationMetric,
  data: ConfluenceData,
): string[] {
  const bullets: string[] = [];
  // Support break risk
  const supports = data.priceLevels
    .filter(l => l.symbol === symbol && l.levelType === 'support')
    .sort((a, b) => b.price - a.price);
  const secMap = new Map(data.securities.map(s => [s.id, s]));
  const pos = data.positions.find(p => secMap.get(p.securityId)?.symbol === symbol);
  const currentPrice = pos?.currentPrice || data.watchlistItems.find(w => w.symbol === symbol)?.lastPrice;
  if (supports.length >= 2 && currentPrice) {
    const s2 = supports[1];
    const downside = ((currentPrice - s2.price) / currentPrice) * 100;
    bullets.push(`Support break below $${s2.price.toFixed(0)} = ${downside.toFixed(1)}% further downside`);
  }
  // Valuation risk if RICH/PRICEY
  if ((v.pegRating === 'RICH' || v.pegRating === 'PRICEY') && v.forwardPe !== null && v.epsGrowthPct !== null) {
    bullets.push(`Forward PE ${v.forwardPe.toFixed(1)}x — priced for ${v.epsGrowthPct.toFixed(0)}% growth`);
  }
  // Fair value risk
  if (v.fairLow !== null && currentPrice && currentPrice < v.fairLow) {
    bullets.push(`Below fair value range (low: $${v.fairLow.toFixed(0)})`);
  }
  if (v.fairHigh !== null && currentPrice && currentPrice > v.fairHigh) {
    bullets.push(`Above fair value ceiling ($${v.fairHigh.toFixed(0)})`);
  }
  return bullets;
}

function buildCopyContext(
  symbol: string,
  v: ValuationMetric,
  signals: string[],
  candidate: { type: string; reason: string },
  data: ConfluenceData,
): string {
  const secMap = new Map(data.securities.map(s => [s.id, s]));
  const pos = data.positions.find(p => secMap.get(p.securityId)?.symbol === symbol);
  const currentPrice = pos?.currentPrice || data.watchlistItems.find(w => w.symbol === symbol)?.lastPrice;
  const supports = data.priceLevels
    .filter(l => l.symbol === symbol && l.levelType === 'support')
    .sort((a, b) => b.price - a.price)
    .slice(0, 2);
  const resistances = data.priceLevels
    .filter(l => l.symbol === symbol && l.levelType === 'resistance')
    .sort((a, b) => a.price - b.price)
    .slice(0, 2);

  const totalMV = data.positions.reduce((sum, p) => sum + (p.marketValue || 0), 0);
  const intent = pos ? data.intents.get(pos.id) : undefined;
  const curPct = pos?.marketValue && totalMV > 0 ? ((pos.marketValue / totalMV) * 100).toFixed(1) : null;

  let text = `I'm looking at ${symbol} as a potential entry. Here's the confluence data:\n\n`;
  text += `Symbol: ${symbol}`;
  if (currentPrice) text += ` | Price: $${currentPrice.toFixed(2)}`;
  if (v.forwardPeg !== null) text += ` | PEG: ${v.forwardPeg.toFixed(2)} (${v.pegRating || '?'})`;
  if (v.forwardPe !== null) text += ` | Fwd PE: ${v.forwardPe.toFixed(1)}x`;
  text += '\n';
  if (v.epsGrowthPct !== null) text += `EPS Growth: +${v.epsGrowthPct.toFixed(0)}%`;
  text += '\n';
  text += `Signals: ${signals.join(', ')}\n`;
  if (supports.length > 0 || resistances.length > 0) {
    text += 'S/R:';
    if (supports.length > 0) text += ' S ' + supports.map(s => `$${s.price.toFixed(2)} (${s.strength}/10)`).join(', S ');
    if (resistances.length > 0) text += ' | R ' + resistances.map(r => `$${r.price.toFixed(2)} (${r.strength}/10)`).join(', R ');
    text += '\n';
  }
  if (v.fairLow !== null && v.fairMid !== null && v.fairHigh !== null) {
    text += `Fair Range: $${v.fairLow.toFixed(0)} – $${v.fairMid.toFixed(0)} – $${v.fairHigh.toFixed(0)}\n`;
  }
  if (pos) {
    text += `Position: ${pos.quantity} shares`;
    if (curPct) text += ` (${curPct}%)`;
    if (intent?.targetAllocationPct) text += `, target ${intent.targetAllocationPct.toFixed(1)}%`;
    text += '\n';
  }
  text += `Type: ${candidate.type === 'investing' ? 'Investing' : 'Trading'} — ${candidate.reason}\n`;
  text += '\nWhat\'s your read? Should I enter here or wait for a better setup?';
  return text;
}

function ValuationSection({ valuations, confluenceData }: { valuations: Map<string, ValuationMetric>; confluenceData: ConfluenceData }) {
  const [sortKey, setSortKey] = useState<SortKey>('symbol');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);
  const [copiedSymbol, setCopiedSymbol] = useState<string | null>(null);
  const [selectedPeerSymbol, setSelectedPeerSymbol] = useState<string | null>(null);
  const [expandedEarnings, setExpandedEarnings] = useState<string | null>(null);

  const items = useMemo(() => Array.from(valuations.values()), [valuations]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'symbol' ? 'asc' : 'desc');
    }
  };

  const sorted = useMemo(() => {
    const list = [...items];
    list.sort((a, b) => {
      let av: number | string | null, bv: number | string | null;
      if (sortKey === 'symbol') { av = a.symbol; bv = b.symbol; }
      else if (sortKey === 'pegRating') {
        const order = { CHEAP: 0, FAIR: 1, RICH: 2, PRICEY: 3 };
        av = a.pegRating ? order[a.pegRating] : 99;
        bv = b.pegRating ? order[b.pegRating] : 99;
      } else {
        av = a[sortKey]; bv = b[sortKey];
      }
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return list;
  }, [items, sortKey, sortDir]);

  // Screening scores
  const screened = useMemo(() => {
    return items.map(v => {
      let score = 0;
      if (v.pegRating === 'CHEAP') score += 3;
      else if (v.pegRating === 'FAIR') score += 2;
      else if (v.pegRating === 'RICH') score += 1;
      if (v.epsGrowthPct !== null) {
        if (v.epsGrowthPct > 50) score += 2;
        else if (v.epsGrowthPct > 30) score += 1;
      }
      return { ...v, score };
    }).sort((a, b) => b.score - a.score);
  }, [items]);

  // Entry confluence
  const confluent = useMemo(() => {
    return items.map(v => {
      const signals: string[] = [];
      if ((v.pegRating === 'CHEAP' || v.pegRating === 'FAIR') && v.forwardPeg !== null && v.forwardPeg < 1.2) {
        signals.push(`Fwd PEG ${v.forwardPeg.toFixed(2)} < 1.2`);
      }
      if (v.epsGrowthPct !== null && v.epsGrowthPct > 20) {
        signals.push(`EPS Growth ${v.epsGrowthPct.toFixed(0)}%`);
      }
      return { ...v, signals };
    }).filter(v => v.signals.length >= 2);
  }, [items]);

  const sortArrow = (key: SortKey) => sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  // Peer comparison data
  const peerData = useMemo(() => {
    if (!selectedPeerSymbol) return null;
    const targetSec = confluenceData.securities.find(s => s.symbol === selectedPeerSymbol);
    const sector = targetSec?.sector;
    if (!sector) return null;

    const peers = items
      .filter(v => {
        const sec = confluenceData.securities.find(s => s.symbol === v.symbol);
        return sec?.sector === sector;
      })
      .map(v => {
        const sec = confluenceData.securities.find(s => s.symbol === v.symbol);
        const secMap = new Map(confluenceData.securities.map(s => [s.id, s]));
        const pos = confluenceData.positions.find(p => secMap.get(p.securityId)?.symbol === v.symbol);
        const totalQty = confluenceData.positions
          .filter(p => secMap.get(p.securityId)?.symbol === v.symbol)
          .reduce((sum, p) => sum + p.quantity, 0);
        const sortPeg = (v.forwardPeg && v.forwardPeg > 0) ? v.forwardPeg : (v.peg && v.peg > 0) ? v.peg : 999;
        return { ...v, industry: sec?.industry, qty: totalQty, isTarget: v.symbol === selectedPeerSymbol, sortPeg, currentPrice: pos?.currentPrice };
      })
      .sort((a, b) => a.sortPeg - b.sortPeg);

    return { sector, industry: targetSec?.industry || '—', peers };
  }, [selectedPeerSymbol, items, confluenceData]);

  // Upcoming earnings (next 30 days)
  const upcomingEarnings = useMemo(() => {
    const today = new Date();
    const thirtyDays = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
    const secMap = new Map(confluenceData.securities.map(s => [s.id, s]));
    const heldSymbols = new Set(
      confluenceData.positions
        .filter(p => p.quantity > 0)
        .map(p => secMap.get(p.securityId)?.symbol)
        .filter(Boolean)
    );

    return confluenceData.earningsEvents
      .filter(e => {
        const d = new Date(e.date);
        return d >= today && d <= thirtyDays && heldSymbols.has(e.symbol);
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [confluenceData]);

  const thClass = 'text-right py-1.5 font-medium text-gray-500 cursor-pointer select-none hover:text-gray-700';
  const thLeftClass = 'text-left py-1.5 font-medium text-gray-500 cursor-pointer select-none hover:text-gray-700';

  if (items.length === 0) {
    return (
      <div className="card text-center py-12">
        <p className="text-gray-500">No valuation data available. Run price refresh to fetch valuations.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Subsection A: Portfolio Valuations */}
      <div className="card">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Portfolio Valuations</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className={thLeftClass} onClick={() => toggleSort('symbol')}>Symbol{sortArrow('symbol')}</th>
                <th className={thClass} onClick={() => toggleSort('trailingPe')}>T12 PE{sortArrow('trailingPe')}</th>
                <th className={thClass} onClick={() => toggleSort('forwardPe')}>Fwd PE{sortArrow('forwardPe')}</th>
                <th className={thClass} onClick={() => toggleSort('peg')}>PEG{sortArrow('peg')}</th>
                <th className={thClass} onClick={() => toggleSort('forwardEps')}>FY EPS{sortArrow('forwardEps')}</th>
                <th className={thClass} onClick={() => toggleSort('epsGrowthPct')}>Growth{sortArrow('epsGrowthPct')}</th>
                <th className={`${thClass} text-center`} onClick={() => toggleSort('pegRating')}>Rating{sortArrow('pegRating')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(v => (
                <tr key={v.symbol} className={`border-b border-gray-100 hover:bg-gray-50 ${selectedPeerSymbol === v.symbol ? 'bg-blue-50' : ''}`}>
                  <td
                    className="py-1.5 font-medium text-blue-700 cursor-pointer hover:underline"
                    onClick={() => setSelectedPeerSymbol(selectedPeerSymbol === v.symbol ? null : v.symbol)}
                  >{v.symbol}</td>
                  <td className="py-1.5 text-right text-gray-700">{fmtNum(v.trailingPe)}</td>
                  <td className="py-1.5 text-right text-gray-700">{fmtNum(v.forwardPe)}</td>
                  <td className="py-1.5 text-right text-gray-700">{fmtNum(v.peg, 2)}</td>
                  <td className="py-1.5 text-right text-gray-700">{fmtNum(v.forwardEps, 2)}</td>
                  <td className={`py-1.5 text-right font-medium ${v.epsGrowthPct !== null && v.epsGrowthPct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {v.epsGrowthPct !== null ? `${v.epsGrowthPct >= 0 ? '+' : ''}${v.epsGrowthPct.toFixed(0)}%` : '—'}
                  </td>
                  <td className="py-1.5 text-center">{pegRatingBadge(v.pegRating)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400 mt-2">Click a symbol to see peer comparison.</p>
      </div>

      {/* Peer Comparison Panel */}
      {peerData && peerData.peers.length >= 2 && (
        <div className="card border-blue-200">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">
                Peer Comparison: {selectedPeerSymbol}
              </h3>
              <p className="text-xs text-gray-500">Sector: {peerData.sector} | Industry: {peerData.industry}</p>
            </div>
            <button
              className="text-gray-400 hover:text-gray-600 text-sm"
              onClick={() => setSelectedPeerSymbol(null)}
            >✕ Close</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-1.5 font-medium text-gray-500">Symbol</th>
                  <th className="text-right py-1.5 font-medium text-gray-500">Price</th>
                  <th className="text-right py-1.5 font-medium text-gray-500">T12 PE</th>
                  <th className="text-right py-1.5 font-medium text-gray-500">Fwd PE</th>
                  <th className="text-right py-1.5 font-medium text-gray-500">PEG</th>
                  <th className="text-right py-1.5 font-medium text-gray-500">Growth</th>
                  <th className="text-center py-1.5 font-medium text-gray-500">Rating</th>
                  <th className="text-right py-1.5 font-medium text-gray-500">Fair Range</th>
                  <th className="text-right py-1.5 font-medium text-gray-500">Held</th>
                </tr>
              </thead>
              <tbody>
                {peerData.peers.map(p => (
                  <tr key={p.symbol} className={`border-b border-gray-100 ${p.isTarget ? 'bg-blue-50 font-medium' : 'hover:bg-gray-50'}`}>
                    <td className="py-1.5 text-gray-900">
                      {p.symbol}
                      {p.isTarget && <span className="text-blue-500 ml-1 text-xs">← you</span>}
                    </td>
                    <td className="py-1.5 text-right text-gray-700">{p.currentPrice ? `$${p.currentPrice.toFixed(0)}` : '—'}</td>
                    <td className="py-1.5 text-right text-gray-700">{fmtNum(p.trailingPe)}</td>
                    <td className="py-1.5 text-right text-gray-700">{fmtNum(p.forwardPe)}</td>
                    <td className="py-1.5 text-right text-gray-700">{p.forwardPeg && p.forwardPeg > 0 ? p.forwardPeg.toFixed(2) : fmtNum(p.peg, 2)}</td>
                    <td className={`py-1.5 text-right font-medium ${p.epsGrowthPct !== null && p.epsGrowthPct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {p.epsGrowthPct !== null ? `${p.epsGrowthPct >= 0 ? '+' : ''}${p.epsGrowthPct.toFixed(0)}%` : '—'}
                    </td>
                    <td className="py-1.5 text-center">{pegRatingBadge(p.pegRating)}</td>
                    <td className="py-1.5 text-right text-gray-600 text-xs">
                      {p.fairLow !== null && p.fairHigh !== null ? `$${p.fairLow.toFixed(0)}–$${p.fairHigh.toFixed(0)}` : '—'}
                    </td>
                    <td className="py-1.5 text-right text-gray-700">{p.qty > 0 ? `${p.qty}sh` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(() => {
            const targetIdx = peerData.peers.findIndex(p => p.isTarget);
            const cheaper = peerData.peers.slice(0, targetIdx).map(p => p.symbol);
            if (targetIdx === 0) return <p className="text-xs text-green-700 mt-2">Cheapest in peer group on PEG basis.</p>;
            if (cheaper.length <= 3) return <p className="text-xs text-gray-600 mt-2">Takeaway: {cheaper.join(', ')} {cheaper.length === 1 ? 'is' : 'are'} cheaper on growth-adjusted basis.</p>;
            return <p className="text-xs text-gray-600 mt-2">Takeaway: {cheaper.slice(0, 3).join(', ')} (+{cheaper.length - 3} more) are cheaper on growth-adjusted basis.</p>;
          })()}
        </div>
      )}

      {/* Subsection B: Upcoming Earnings */}
      {upcomingEarnings.length > 0 && (
        <div className="card">
          <h3 className="text-lg font-semibold text-gray-900 mb-3">Upcoming Earnings</h3>
          <p className="text-xs text-gray-500 mb-3">Portfolio positions with earnings in the next 30 days. Click to expand.</p>
          <div className="space-y-2">
            {upcomingEarnings.map(e => {
              const isExpEarnings = expandedEarnings === e.symbol;
              const v = valuations.get(e.symbol);
              const secMap = new Map(confluenceData.securities.map(s => [s.id, s]));
              const pos = confluenceData.positions.find(p => secMap.get(p.securityId)?.symbol === e.symbol);
              const intent = pos ? confluenceData.intents.get(pos.id) : undefined;
              const daysUntil = Math.ceil((new Date(e.date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
              const supports = confluenceData.priceLevels
                .filter(l => l.symbol === e.symbol && l.levelType === 'support')
                .sort((a, b) => b.price - a.price)
                .slice(0, 2);
              const resistances = confluenceData.priceLevels
                .filter(l => l.symbol === e.symbol && l.levelType === 'resistance')
                .sort((a, b) => a.price - b.price)
                .slice(0, 2);

              return (
                <div
                  key={e.symbol}
                  className={`border rounded-lg p-3 cursor-pointer transition-colors ${isExpEarnings ? 'border-purple-300 bg-purple-50/30' : 'border-gray-200 hover:border-purple-200'}`}
                  onClick={() => setExpandedEarnings(isExpEarnings ? null : e.symbol)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="font-semibold text-gray-900">{e.symbol}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">
                        {e.date} ({daysUntil}d)
                      </span>
                      {e.time && <span className="text-xs text-gray-400">{e.time === 'bmo' ? 'Pre-market' : e.time === 'amc' ? 'After-close' : ''}</span>}
                      {v && pegRatingBadge(v.pegRating)}
                      {intent?.tier && <span className="text-xs text-gray-500">{intent.tier}</span>}
                    </div>
                    <span className="text-gray-400 text-sm">{isExpEarnings ? '▲' : '▼'}</span>
                  </div>

                  {isExpEarnings && (
                    <div className="mt-3 pt-3 border-t border-purple-200 space-y-2 text-sm" onClick={ev => ev.stopPropagation()}>
                      {/* Position */}
                      {pos && (
                        <div>
                          <span className="text-xs font-semibold text-gray-500 uppercase">Position</span>
                          <div className="text-gray-700">
                            {pos.quantity} shares | MV: ${(pos.marketValue || 0).toLocaleString()} | Cost: ${pos.costBasis.toLocaleString()}
                            {intent?.thesis && <div className="text-xs text-gray-500 mt-0.5">Thesis: {intent.thesis}</div>}
                          </div>
                        </div>
                      )}
                      {/* Valuation */}
                      {v && (
                        <div>
                          <span className="text-xs font-semibold text-gray-500 uppercase">Valuation</span>
                          <div className="flex flex-wrap gap-x-4 text-gray-700">
                            {v.forwardPe !== null && <span>Fwd PE: <strong>{v.forwardPe.toFixed(1)}x</strong></span>}
                            {v.forwardPeg !== null && <span>PEG: <strong>{v.forwardPeg.toFixed(2)}</strong></span>}
                            {v.epsGrowthPct !== null && <span>EPS Growth: <strong className={v.epsGrowthPct >= 0 ? 'text-green-600' : 'text-red-600'}>{v.epsGrowthPct >= 0 ? '+' : ''}{v.epsGrowthPct.toFixed(0)}%</strong></span>}
                            {e.epsEstimated && <span>Est EPS: <strong>${e.epsEstimated.toFixed(2)}</strong></span>}
                          </div>
                          {v.fairLow !== null && v.fairMid !== null && v.fairHigh !== null && (
                            <div className="text-xs text-gray-500 mt-0.5">Fair: ${v.fairLow.toFixed(0)} – ${v.fairMid.toFixed(0)} – ${v.fairHigh.toFixed(0)}</div>
                          )}
                        </div>
                      )}
                      {/* S/R */}
                      {(supports.length > 0 || resistances.length > 0) && (
                        <div>
                          <span className="text-xs font-semibold text-gray-500 uppercase">S/R Levels</span>
                          <div className="text-gray-700">
                            {supports.length > 0 && <span>S: {supports.map(s => `$${s.price.toFixed(0)} (${s.strength}/10)`).join('  ')}</span>}
                            {supports.length > 0 && resistances.length > 0 && <span className="mx-2">|</span>}
                            {resistances.length > 0 && <span>R: {resistances.map(r => `$${r.price.toFixed(0)} (${r.strength}/10)`).join('  ')}</span>}
                          </div>
                        </div>
                      )}
                      <p className="text-xs text-gray-400 mt-1">Full prep: <code className="bg-gray-100 px-1 rounded">pm-cli.sh earnings-prep {e.symbol}</code></p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Subsection C: Watchlist Screening */}
      <div className="card">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Screening Scores</h3>
        <p className="text-xs text-gray-500 mb-3">Composite: CHEAP=3, FAIR=2, RICH=1, PRICEY=0 + Growth &gt;50%=+2, &gt;30%=+1</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-1.5 font-medium text-gray-500">Symbol</th>
                <th className="text-center py-1.5 font-medium text-gray-500">Rating</th>
                <th className="text-right py-1.5 font-medium text-gray-500">PEG</th>
                <th className="text-right py-1.5 font-medium text-gray-500">Growth</th>
                <th className="text-right py-1.5 font-medium text-gray-500">Score</th>
              </tr>
            </thead>
            <tbody>
              {screened.map(v => (
                <tr key={v.symbol} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-1.5 font-medium text-gray-900">{v.symbol}</td>
                  <td className="py-1.5 text-center">{pegRatingBadge(v.pegRating)}</td>
                  <td className="py-1.5 text-right text-gray-700">{fmtNum(v.peg, 2)}</td>
                  <td className={`py-1.5 text-right font-medium ${v.epsGrowthPct !== null && v.epsGrowthPct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {v.epsGrowthPct !== null ? `${v.epsGrowthPct >= 0 ? '+' : ''}${v.epsGrowthPct.toFixed(0)}%` : '—'}
                  </td>
                  <td className="py-1.5 text-right font-bold text-gray-900">{v.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Subsection C: Entry Confluence */}
      <div className="card">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Entry Confluence</h3>
        <p className="text-xs text-gray-500 mb-3">Symbols with 2+ aligned signals: valuation (CHEAP/FAIR + Fwd PEG &lt; 1.2) and EPS growth &gt; 20%. Click to expand.</p>
        {confluent.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-4">No symbols currently meet multi-signal entry criteria.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {confluent.map(v => {
              const isExpanded = expandedSymbol === v.symbol;
              const candidate = classifyCandidate(v.symbol, v, confluenceData);
              const whyNow = isExpanded ? buildWhyNow(v.symbol, v, confluenceData) : [];
              const risks = isExpanded ? buildRisks(v.symbol, v, confluenceData) : [];
              const secMap = new Map(confluenceData.securities.map(s => [s.id, s]));
              const pos = confluenceData.positions.find(p => secMap.get(p.securityId)?.symbol === v.symbol);
              const currentPrice = pos?.currentPrice || confluenceData.watchlistItems.find(w => w.symbol === v.symbol)?.lastPrice;
              const supports = confluenceData.priceLevels
                .filter(l => l.symbol === v.symbol && l.levelType === 'support')
                .sort((a, b) => b.price - a.price)
                .slice(0, 2);
              const resistances = confluenceData.priceLevels
                .filter(l => l.symbol === v.symbol && l.levelType === 'resistance')
                .sort((a, b) => a.price - b.price)
                .slice(0, 2);

              // Trend + R:R
              const trend = confluenceData.trendIndicators.find(t => t.symbol === v.symbol);
              const s1 = supports[0];
              const r1 = resistances[0];
              const rr = s1 && r1 && currentPrice
                ? (r1.price - currentPrice) / (currentPrice - s1.price)
                : null;
              const isTradeable = trend && (trend.trend === 'UPTREND' || trend.trend === 'PULLBACK');
              const symbolSector = getSymbolSector(v.symbol, confluenceData);
              const isRegimeBlocked = symbolSector ? confluenceData.punishedSectors.has(symbolSector) : false;
              const rrFavorable = rr !== null && rr >= 2.0;

              const trendColor: Record<string, string> = {
                UPTREND: 'bg-green-100 text-green-800',
                PULLBACK: 'bg-yellow-100 text-yellow-800',
                DOWNTREND: 'bg-red-100 text-red-800',
                BREAKDOWN: 'bg-red-100 text-red-800',
              };

              return (
                <div
                  key={v.symbol}
                  className={`border rounded-lg p-3 transition-colors cursor-pointer ${
                    isExpanded ? 'border-blue-400 bg-blue-50/30 col-span-1 sm:col-span-2 lg:col-span-3'
                      : isRegimeBlocked ? 'border-gray-200 bg-gray-50/50 opacity-60 hover:opacity-80'
                      : isTradeable && rrFavorable ? 'border-green-300 bg-green-50/20 hover:border-green-400'
                      : isTradeable ? 'border-yellow-200 hover:border-yellow-300'
                      : 'border-gray-200 hover:border-blue-300'
                  }`}
                  onClick={() => setExpandedSymbol(isExpanded ? null : v.symbol)}
                >
                  {/* Header row */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-900">{v.symbol}</span>
                      {pegRatingBadge(v.pegRating)}
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        candidate.type === 'investing' ? 'bg-indigo-100 text-indigo-700' : 'bg-orange-100 text-orange-700'
                      }`}>
                        {candidate.type === 'investing' ? 'Investing' : 'Trading'}
                      </span>
                      {trend && (
                        <span className={`text-xs px-1.5 py-0.5 rounded ${trendColor[trend.trend] || 'bg-gray-100 text-gray-700'}`}>
                          {trend.trend}
                        </span>
                      )}
                      {rr !== null && (
                        <span className={`text-xs px-1.5 py-0.5 rounded ${rrFavorable ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                          R:R {rr.toFixed(1)}x
                        </span>
                      )}
                      {isRegimeBlocked && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-red-50 text-red-600">
                          REGIME
                        </span>
                      )}
                    </div>
                    <span className="text-gray-400 text-sm">{isExpanded ? '▲' : '▼'}</span>
                  </div>

                  {/* Signal checkmarks (always visible) */}
                  <ul className="space-y-0.5">
                    {v.signals.map((s, i) => (
                      <li key={i} className="text-xs text-gray-600 flex items-center gap-1">
                        <span className="text-green-500">&#10003;</span> {s}
                      </li>
                    ))}
                  </ul>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="mt-3 pt-3 border-t border-blue-200 space-y-3" onClick={e => e.stopPropagation()}>
                      {/* Type classification */}
                      <div>
                        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Type</span>
                        <p className="text-sm text-gray-800 mt-0.5">
                          {candidate.type === 'investing' ? 'Investing' : 'Trading'} — {candidate.reason}
                        </p>
                      </div>

                      {/* Why Now */}
                      {whyNow.length > 0 && (
                        <div>
                          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Why Now</span>
                          <ul className="mt-1 space-y-0.5">
                            {whyNow.map((b, i) => (
                              <li key={i} className="text-sm text-gray-700 flex items-start gap-1.5">
                                <span className="text-blue-400 mt-0.5 shrink-0">•</span>
                                <span>{b}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Risk to Watch */}
                      {risks.length > 0 && (
                        <div>
                          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Risk to Watch</span>
                          <ul className="mt-1 space-y-0.5">
                            {risks.map((b, i) => (
                              <li key={i} className="text-sm text-gray-700 flex items-start gap-1.5">
                                <span className="text-amber-500 mt-0.5 shrink-0">•</span>
                                <span>{b}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Key Data */}
                      <div>
                        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Key Data</span>
                        <div className="mt-1 text-sm text-gray-700 space-y-0.5">
                          <div className="flex flex-wrap gap-x-4">
                            {currentPrice && <span>Price: <strong>${currentPrice.toFixed(2)}</strong></span>}
                            {v.forwardPe !== null && <span>Fwd PE: <strong>{v.forwardPe.toFixed(1)}x</strong></span>}
                            {v.forwardPeg !== null && <span>PEG: <strong>{v.forwardPeg.toFixed(2)}</strong></span>}
                            {v.epsGrowthPct !== null && <span>EPS Growth: <strong className="text-green-600">+{v.epsGrowthPct.toFixed(0)}%</strong></span>}
                          </div>
                          {supports.length > 0 && (
                            <div>
                              S: {supports.map((s, i) => (
                                <span key={i}>
                                  {i > 0 && '  '}
                                  <span className="text-green-700">${s.price.toFixed(0)}</span>
                                  <span className="text-gray-400"> ({s.strength}/10)</span>
                                </span>
                              ))}
                            </div>
                          )}
                          {resistances.length > 0 && (
                            <div>
                              R: {resistances.map((r, i) => (
                                <span key={i}>
                                  {i > 0 && '  '}
                                  <span className="text-red-600">${r.price.toFixed(0)}</span>
                                  <span className="text-gray-400"> ({r.strength}/10)</span>
                                </span>
                              ))}
                            </div>
                          )}
                          {v.fairLow !== null && v.fairMid !== null && v.fairHigh !== null && (
                            <div>Fair Range: ${v.fairLow.toFixed(0)} – <strong>${v.fairMid.toFixed(0)}</strong> – ${v.fairHigh.toFixed(0)}</div>
                          )}
                        </div>
                      </div>

                      {/* Trend + Trade Assessment */}
                      {trend && (
                        <div>
                          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Trade Assessment</span>
                          <div className="mt-1 text-sm text-gray-700 space-y-0.5">
                            <div className="flex flex-wrap gap-x-4">
                              <span>Trend: <strong className={isTradeable ? 'text-green-700' : 'text-red-600'}>{trend.trend}</strong></span>
                              <span>RSI: <strong className={trend.rsi <= 30 ? 'text-red-600' : trend.rsi >= 70 ? 'text-amber-600' : ''}>{trend.rsi.toFixed(0)}</strong></span>
                              <span>DMAs: <strong>{trend.aboveDmas}/3</strong> above</span>
                              {rr !== null && <span>R:R: <strong className={rrFavorable ? 'text-green-700' : 'text-amber-600'}>{rr.toFixed(1)}x</strong></span>}
                            </div>
                            <div className="flex flex-wrap gap-x-4 text-xs text-gray-500">
                              <span>20 DMA: ${trend.sma20.toFixed(0)}</span>
                              <span>50 DMA: ${trend.sma50.toFixed(0)}</span>
                              {trend.sma200 > 0 && <span>200 DMA: ${trend.sma200.toFixed(0)}</span>}
                            </div>
                            <div className={`mt-1 text-xs font-medium px-2 py-1 rounded inline-block ${
                              isTradeable && rrFavorable ? 'bg-green-100 text-green-800' :
                              isTradeable ? 'bg-yellow-100 text-yellow-800' :
                              'bg-red-50 text-red-700'
                            }`}>
                              {isTradeable && rrFavorable
                                ? `TRADEABLE — R:R ${rr!.toFixed(1)}x at current price`
                                : isTradeable && rr !== null
                                ? `TREND OK — R:R ${rr.toFixed(1)}x insufficient, wait for pullback${trend.sma50 ? ` to 50 DMA $${trend.sma50.toFixed(0)}` : ''}`
                                : isTradeable
                                ? 'TREND OK — no S/R data for R:R'
                                : `NOT TRADEABLE — wait for ${trend.trend === 'DOWNTREND' ? `20 DMA reclaim $${trend.sma20.toFixed(0)}` : `200 DMA reclaim $${trend.sma200.toFixed(0)}`}`
                              }
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Copy Context button */}
                      <button
                        className={`mt-1 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                          copiedSymbol === v.symbol
                            ? 'bg-green-100 text-green-700'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          const text = buildCopyContext(v.symbol, v, v.signals, candidate, confluenceData);
                          navigator.clipboard.writeText(text);
                          setCopiedSymbol(v.symbol);
                          setTimeout(() => setCopiedSymbol(null), 2000);
                        }}
                      >
                        {copiedSymbol === v.symbol ? 'Copied!' : 'Copy Context'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Analytics() {
  const { analytics, positionBetas, loading, fetchAnalytics } = useAnalytics();
  const { transactions, loading: txLoading, fetchTransactions, createTransaction, deleteTransaction } = useTransactions();
  const { accounts, fetchAccounts } = useAccounts();
  const { securities, fetchSecurities, createSecurity, findBySymbol } = useSecurities();
  const [selectedPeriod, setSelectedPeriod] = useState(90);
  const [activeTab, setActiveTab] = useState<'analytics' | 'transactions' | 'trade-performance' | 'valuation'>('analytics');

  // Transaction state
  const [showTxModal, setShowTxModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [filterAccount, setFilterAccount] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterSymbol, setFilterSymbol] = useState('');
  const [filterSide, setFilterSide] = useState('');
  const [txFormData, setTxFormData] = useState({
    accountId: '', symbol: '', name: '', securityType: 'stock' as Security['type'],
    type: 'buy' as Transaction['type'], date: format(new Date(), 'yyyy-MM-dd'),
    quantity: '', price: '', fees: '', notes: '',
  });

  useEffect(() => {
    fetchAnalytics(selectedPeriod);
  }, [selectedPeriod, fetchAnalytics]);

  const { valuations, loading: valLoading, fetchValuations } = useValuationMetrics();
  const { tradeAnalytics, loading: tpLoading, fetchTradeAnalytics } = useTradeAnalytics();
  const [tpPeriod, setTpPeriod] = useState<number | undefined>(undefined); // undefined = all time
  const [tpView, setTpView] = useState<'summary' | 'journal'>('summary');
  const { entries: journalEntries, loading: journalLoading, fetchJournal } = useTradeJournal();
  const [journalSymbolFilter, setJournalSymbolFilter] = useState('');

  // Confluence data hooks
  const { positions: cfPositions, fetchPositions: fetchCfPositions } = usePositions();
  const { intents: cfIntents, fetchIntents: fetchCfIntents } = usePositionIntents();
  const { levels: cfLevels, fetchLevels: fetchCfLevels } = usePriceLevels();
  const { items: cfWatchlistItems, fetchItems: fetchCfWatchlistItems } = useWatchlists();
  const { indicators: cfTrend, fetchIndicators: fetchCfTrend } = useTrendIndicators();
  const { earnings: cfEarnings, fetchPortfolioEarnings: fetchCfEarnings } = useEarnings();
  const [cfPunishedSectors, setCfPunishedSectors] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (activeTab === 'transactions') {
      fetchTransactions();
      fetchAccounts();
      fetchSecurities();
    }
  }, [activeTab, fetchTransactions, fetchAccounts, fetchSecurities]);

  useEffect(() => {
    if (activeTab === 'valuation') {
      fetchValuations();
      fetchSecurities();
      fetchCfPositions();
      fetchCfIntents();
      fetchCfLevels();
      fetchCfWatchlistItems();
      fetchCfTrend();
      fetchCfEarnings();
      // Fetch regime for confluence filtering
      const today = new Date().toISOString().split('T')[0];
      window.electronAPI.getDailyRitual(today).then(ritual => {
        if (ritual) {
          setCfPunishedSectors(parsePunishedSectors(ritual.regimePunishing || null));
        }
      });
    }
  }, [activeTab, fetchValuations, fetchSecurities, fetchCfPositions, fetchCfIntents, fetchCfLevels, fetchCfWatchlistItems, fetchCfTrend, fetchCfEarnings]);

  useEffect(() => {
    if (activeTab === 'trade-performance') fetchTradeAnalytics(tpPeriod);
  }, [activeTab, tpPeriod, fetchTradeAnalytics]);

  useEffect(() => {
    if (activeTab === 'trade-performance' && tpView === 'journal') {
      fetchJournal({ symbol: journalSymbolFilter || undefined, days: tpPeriod });
    }
  }, [activeTab, tpView, tpPeriod, journalSymbolFilter, fetchJournal]);

  const securityMap = useMemo(() => new Map(securities.map(s => [s.id, s])), [securities]);
  const accountMap = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);

  const uniqueSymbols = useMemo(() =>
    Array.from(new Set(transactions.map(t => securityMap.get(t.securityId)?.symbol).filter(Boolean))).sort() as string[],
    [transactions, securityMap]
  );

  const filteredTransactions = useMemo(() =>
    transactions.filter(t => {
      if (filterAccount && t.accountId !== filterAccount) return false;
      if (filterType && t.type !== filterType) return false;
      if (filterSymbol && securityMap.get(t.securityId)?.symbol !== filterSymbol) return false;
      if (filterSide === 'buy' && t.type !== 'buy') return false;
      if (filterSide === 'sell' && t.type !== 'sell') return false;
      return true;
    }),
    [transactions, filterAccount, filterType, filterSymbol, filterSide, securityMap]
  );

  const handleTxSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    let security = await findBySymbol(txFormData.symbol);
    if (!security) {
      security = await createSecurity({
        symbol: txFormData.symbol.toUpperCase(),
        name: txFormData.name || txFormData.symbol.toUpperCase(),
        type: txFormData.securityType, currency: 'USD',
      });
    }
    const quantity = parseFloat(txFormData.quantity);
    const price = parseFloat(txFormData.price);
    const fees = txFormData.fees ? parseFloat(txFormData.fees) : 0;
    await createTransaction({
      accountId: txFormData.accountId, securityId: security.id, type: txFormData.type,
      date: txFormData.date, quantity, price, amount: quantity * price, fees,
      notes: txFormData.notes || undefined,
    });
    setShowTxModal(false);
    fetchSecurities();
  };

  const isEmpty = !analytics || analytics.dataPoints === 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
          <div className="flex gap-1">
            {(['analytics', 'transactions', 'trade-performance', 'valuation'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  activeTab === tab
                    ? 'bg-blue-100 text-blue-700'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                }`}
              >
                {tab === 'analytics' ? 'Portfolio' : tab === 'transactions' ? 'Transactions' : tab === 'trade-performance' ? 'Trade Performance' : 'Valuation'}
              </button>
            ))}
          </div>
        </div>
        {activeTab === 'analytics' && (
          <div className="flex items-center gap-1">
            {PERIODS.map(p => (
              <button
                key={p.days}
                onClick={() => setSelectedPeriod(p.days)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  selectedPeriod === p.days
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
        {activeTab === 'transactions' && (
          <div className="flex gap-3">
            <button onClick={() => setShowImportModal(true)} className="btn-secondary">Import from Brokerage</button>
            <button onClick={() => {
              setTxFormData({ accountId: accounts[0]?.id || '', symbol: '', name: '', securityType: 'stock', type: 'buy', date: format(new Date(), 'yyyy-MM-dd'), quantity: '', price: '', fees: '', notes: '' });
              setShowTxModal(true);
            }} className="btn-primary">Add Transaction</button>
          </div>
        )}
      </div>

      {activeTab === 'analytics' && (
        <>
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-gray-500">Loading...</div>
            </div>
          ) : (
            <>
              {isEmpty ? (
                <div className="card">
                  <div className="flex flex-col items-center justify-center py-8">
                    <p className="text-gray-500 mb-1">Portfolio-level analytics require daily snapshots</p>
                    <p className="text-gray-400 text-sm">
                      Run <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono">pm-cli.sh snapshot</code> daily to build history.
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  {/* Stat Cards */}
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                    <div className="card">
                      <p className="stat-label">Beta</p>
                      <p className={`stat-value ${betaColor(analytics!.weightedBeta)}`}>{analytics!.weightedBeta.toFixed(2)}</p>
                      <p className="text-xs text-gray-400 mt-1">vs SPY</p>
                    </div>
                    <div className="card">
                      <p className="stat-label">Sharpe Ratio</p>
                      {analytics!.dataPoints >= 30 ? (
                        <p className={`stat-value ${sharpeColor(analytics!.sharpeRatio)}`}>{analytics!.sharpeRatio.toFixed(2)}</p>
                      ) : (
                        <p className="text-xs text-gray-400 mt-2">Insufficient data, requires minimum 30 days</p>
                      )}
                    </div>
                    <div className="card">
                      <p className="stat-label">Volatility</p>
                      <p className="stat-value">{(analytics!.volatility * 100).toFixed(1)}%</p>
                      <p className="text-xs text-gray-400 mt-1">annualized</p>
                    </div>
                    <div className="card">
                      <p className="stat-label">Max Drawdown</p>
                      <p className={`stat-value ${drawdownColor(analytics!.maxDrawdown)}`}>-{Math.abs(analytics!.maxDrawdown).toFixed(1)}%</p>
                      <p className="text-xs text-gray-400 mt-1">{analytics!.maxDrawdownDate}</p>
                    </div>
                    <div className="card">
                      <p className="stat-label">Current Drawdown</p>
                      <p className={`stat-value ${drawdownColor(analytics!.currentDrawdown)}`}>-{Math.abs(analytics!.currentDrawdown).toFixed(1)}%</p>
                    </div>
                  </div>

                  {/* Returns Comparison */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="card">
                      <p className="stat-label">Portfolio Return</p>
                      <p className={`stat-value ${returnColor(analytics!.totalReturn)}`}>{formatPct(analytics!.totalReturn)}</p>
                      <p className="text-xs text-gray-400 mt-1">{analytics!.periodDays} days</p>
                    </div>
                    <div className="card">
                      <p className="stat-label">Annualized Return</p>
                      {analytics!.dataPoints >= 30 ? (
                        <p className={`stat-value ${returnColor(analytics!.annualizedReturn)}`}>{formatPct(analytics!.annualizedReturn)}</p>
                      ) : (
                        <p className="text-xs text-gray-400 mt-2">Insufficient data, requires minimum 30 days</p>
                      )}
                    </div>
                    <div className="card">
                      <p className="stat-label">SPY Return</p>
                      <p className={`stat-value ${returnColor(analytics!.benchmarkReturn)}`}>{formatPct(analytics!.benchmarkReturn)}</p>
                      <p className="text-xs text-gray-400 mt-1">{analytics!.periodDays} days</p>
                    </div>
                  </div>
                </>
              )}

              {/* Concentration & Correlation */}
              <CorrelationConcentrationSection period={selectedPeriod} />

              {/* Position Beta Table */}
              {positionBetas.length > 0 && (
                <div className="card">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold text-gray-900">Position Betas</h2>
                    <span className="text-xs text-gray-400">{selectedPeriod}d vs SPY</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-200">
                          <th className="text-left py-2 px-3 font-medium text-gray-500">Symbol</th>
                          <th className="text-right py-2 px-3 font-medium text-gray-500">Beta</th>
                          <th className="text-right py-2 px-3 font-medium text-gray-500">Correlation</th>
                          <th className="text-right py-2 px-3 font-medium text-gray-500">Weight (%)</th>
                          <th className="text-right py-2 px-3 font-medium text-gray-500">Weighted Beta</th>
                        </tr>
                      </thead>
                      <tbody>
                        {positionBetas.map(pb => (
                          <tr key={pb.symbol} className="border-b border-gray-100 hover:bg-gray-50">
                            <td className="py-2 px-3 font-medium text-gray-900">{pb.symbol}</td>
                            <td className={`py-2 px-3 text-right font-medium ${betaColor(pb.beta)}`}>{pb.beta.toFixed(2)}</td>
                            <td className="py-2 px-3 text-right text-gray-700">{pb.correlation.toFixed(2)}</td>
                            <td className="py-2 px-3 text-right text-gray-700">{(pb.weight * 100).toFixed(1)}</td>
                            <td className="py-2 px-3 text-right text-gray-700">{pb.weightedBeta.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-gray-300">
                          <td className="py-2 px-3 font-semibold text-gray-900">Total</td>
                          <td className="py-2 px-3"></td>
                          <td className="py-2 px-3"></td>
                          <td className="py-2 px-3"></td>
                          <td className="py-2 px-3 text-right font-semibold text-gray-900">
                            {positionBetas.reduce((sum, pb) => sum + pb.weightedBeta, 0).toFixed(2)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {activeTab === 'transactions' && (
        <>
          {/* Transactions Tab */}
          {/* Filters */}
          <div className="flex gap-4">
            <select className="select w-48" value={filterAccount} onChange={(e) => setFilterAccount(e.target.value)}>
              <option value="">All Accounts</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select className="select w-48" value={filterSymbol} onChange={(e) => setFilterSymbol(e.target.value)}>
              <option value="">All Tickers</option>
              {uniqueSymbols.map(sym => <option key={sym} value={sym}>{sym}</option>)}
            </select>
            <select className="select w-36" value={filterSide} onChange={(e) => setFilterSide(e.target.value)}>
              <option value="">All Sides</option>
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
            <select className="select w-48" value={filterType} onChange={(e) => setFilterType(e.target.value)}>
              <option value="">All Types</option>
              {transactionTypes.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}
            </select>
          </div>

          {txLoading ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-gray-500">Loading...</div>
            </div>
          ) : filteredTransactions.length === 0 ? (
            <div className="card text-center py-12">
              <p className="text-gray-500">No transactions yet.</p>
              <p className="text-sm text-gray-400 mt-1">Add transactions manually or import from your brokerage.</p>
            </div>
          ) : (
            <div className="card overflow-hidden p-0">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="table-header">Date</th>
                      <th className="table-header">Type</th>
                      <th className="table-header">Symbol</th>
                      <th className="table-header">Account</th>
                      <th className="table-header text-right">Quantity</th>
                      <th className="table-header text-right">Price</th>
                      <th className="table-header text-right">Amount</th>
                      <th className="table-header text-right">Fees</th>
                      <th className="table-header">Notes</th>
                      <th className="table-header text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {filteredTransactions.map(transaction => {
                      const security = securityMap.get(transaction.securityId);
                      const account = accountMap.get(transaction.accountId);
                      return (
                        <tr key={transaction.id} className="hover:bg-gray-50">
                          <td className="table-cell">{format(new Date(transaction.date), 'MMM d, yyyy')}</td>
                          <td className="table-cell">
                            <span className={`badge ${getTypeColor(transaction.type)} capitalize`}>{transaction.type.replace('_', ' ')}</span>
                          </td>
                          <td className="table-cell font-medium">{security?.symbol || 'Unknown'}</td>
                          <td className="table-cell text-gray-500">{account?.name || 'Unknown'}</td>
                          <td className="table-cell text-right">{transaction.quantity.toLocaleString()}</td>
                          <td className="table-cell text-right">{formatCurrency(transaction.price)}</td>
                          <td className="table-cell text-right">{formatCurrency(transaction.amount)}</td>
                          <td className="table-cell text-right">{transaction.fees ? formatCurrency(transaction.fees) : '-'}</td>
                          <td className="table-cell text-gray-500 max-w-xs truncate">{transaction.notes || '-'}</td>
                          <td className="table-cell text-right">
                            <button
                              onClick={async () => {
                                if (window.confirm('Delete this transaction?')) await deleteTransaction(transaction.id);
                              }}
                              className="text-red-600 hover:text-red-700"
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Import Modal */}
          <TransactionImportModal
            isOpen={showImportModal}
            onClose={() => setShowImportModal(false)}
            onImportComplete={() => { fetchTransactions(); fetchSecurities(); }}
          />

          {/* Add Transaction Modal */}
          {showTxModal && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
              <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Add Transaction</h2>
                <form onSubmit={handleTxSubmit} className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="label">Account</label>
                      <select className="select" value={txFormData.accountId} onChange={(e) => setTxFormData({ ...txFormData, accountId: e.target.value })} required>
                        <option value="">Select Account</option>
                        {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="label">Type</label>
                      <select className="select" value={txFormData.type} onChange={(e) => setTxFormData({ ...txFormData, type: e.target.value as Transaction['type'] })} required>
                        {transactionTypes.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="label">Symbol</label>
                      <input type="text" className="input" value={txFormData.symbol} onChange={(e) => setTxFormData({ ...txFormData, symbol: e.target.value.toUpperCase() })} placeholder="e.g., AAPL" required />
                    </div>
                    <div>
                      <label className="label">Security Type</label>
                      <select className="select" value={txFormData.securityType} onChange={(e) => setTxFormData({ ...txFormData, securityType: e.target.value as Security['type'] })}>
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
                    <label className="label">Security Name (Optional)</label>
                    <input type="text" className="input" value={txFormData.name} onChange={(e) => setTxFormData({ ...txFormData, name: e.target.value })} placeholder="e.g., Apple Inc." />
                  </div>
                  <div>
                    <label className="label">Date</label>
                    <input type="date" className="input" value={txFormData.date} onChange={(e) => setTxFormData({ ...txFormData, date: e.target.value })} required />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="label">Quantity</label>
                      <input type="number" step="any" className="input" value={txFormData.quantity} onChange={(e) => setTxFormData({ ...txFormData, quantity: e.target.value })} required />
                    </div>
                    <div>
                      <label className="label">Price ($)</label>
                      <input type="number" step="0.0001" className="input" value={txFormData.price} onChange={(e) => setTxFormData({ ...txFormData, price: e.target.value })} required />
                    </div>
                  </div>
                  <div>
                    <label className="label">Fees ($, Optional)</label>
                    <input type="number" step="0.01" className="input" value={txFormData.fees} onChange={(e) => setTxFormData({ ...txFormData, fees: e.target.value })} placeholder="0.00" />
                  </div>
                  <div>
                    <label className="label">Notes (Optional)</label>
                    <textarea className="input" rows={2} value={txFormData.notes} onChange={(e) => setTxFormData({ ...txFormData, notes: e.target.value })} placeholder="Any additional notes..." />
                  </div>
                  <div className="flex justify-end gap-3 pt-4">
                    <button type="button" onClick={() => setShowTxModal(false)} className="btn-secondary">Cancel</button>
                    <button type="submit" className="btn-primary">Add Transaction</button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </>
      )}

      {activeTab === 'trade-performance' && (
        <>
          <div className="flex items-center justify-between mb-4">
            <div className="flex gap-1">
              {([
                { label: '30D', value: 30 },
                { label: '90D', value: 90 },
                { label: '180D', value: 180 },
                { label: '1Y', value: 365 },
                { label: 'All', value: undefined },
              ] as Array<{ label: string; value: number | undefined }>).map(({ label, value }) => (
                <button
                  key={label}
                  onClick={() => setTpPeriod(value)}
                  className={`px-3 py-1 text-sm rounded-md ${
                    tpPeriod === value
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-gray-600 hover:bg-gray-50 border border-gray-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex gap-1">
              {(['summary', 'journal'] as const).map(v => (
                <button key={v} onClick={() => setTpView(v)}
                  className={`px-3 py-1 text-sm rounded-md ${tpView === v ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50 border border-gray-200'}`}>
                  {v === 'summary' ? 'Summary' : 'Journal'}
                </button>
              ))}
            </div>
          </div>
          {tpView === 'summary' && (
          <>
          {tpLoading ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-gray-500">Loading...</div>
            </div>
          ) : !tradeAnalytics || tradeAnalytics.summary.totalTrades === 0 ? (
            <div className="card text-center py-12">
              <p className="text-gray-500">No closed trades found.</p>
              <p className="text-sm text-gray-400 mt-1">Analytics will appear once you have sell transactions matched to prior buys.</p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Summary Cards */}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                <div className="card">
                  <p className="stat-label">Total Trades</p>
                  <p className="stat-value">{tradeAnalytics.summary.totalTrades}</p>
                </div>
                <div className="card">
                  <p className="stat-label">Win Rate</p>
                  <p className={`stat-value ${tradeAnalytics.summary.winRate >= 50 ? 'text-green-600' : 'text-red-600'}`}>
                    {tradeAnalytics.summary.winRate.toFixed(1)}%
                  </p>
                  <p className="text-xs text-gray-400 mt-1">{tradeAnalytics.summary.wins}W / {tradeAnalytics.summary.losses}L</p>
                </div>
                <div className="card">
                  <p className="stat-label">Total P&L</p>
                  <p className={`stat-value ${returnColor(tradeAnalytics.summary.totalRealizedGain)}`}>
                    {formatCurrency(tradeAnalytics.summary.totalRealizedGain)}
                  </p>
                </div>
                <div className="card">
                  <p className="stat-label">Avg Win / Loss</p>
                  <p className="stat-value text-green-600">{formatCurrency(tradeAnalytics.summary.avgWin)}</p>
                  <p className="text-xs text-red-600 mt-1">{formatCurrency(tradeAnalytics.summary.avgLoss)}</p>
                </div>
                <div className="card">
                  <p className="stat-label">Profit Factor</p>
                  <p className={`stat-value ${tradeAnalytics.summary.profitFactor >= 1 ? 'text-green-600' : 'text-red-600'}`}>
                    {tradeAnalytics.summary.profitFactor === Infinity ? '\u221E' : tradeAnalytics.summary.profitFactor.toFixed(2)}
                  </p>
                </div>
              </div>

              {/* Breakdown Tables */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {[
                  { title: 'By Hold Period', data: tradeAnalytics.byHoldPeriod },
                  { title: 'By Regime at Entry', data: tradeAnalytics.byRegimeAtEntry },
                  { title: 'By Entry Style', data: tradeAnalytics.byEntryStyle },
                ].map(({ title, data }) => (
                  <div key={title} className="card">
                    <h3 className="text-sm font-semibold text-gray-900 mb-3">{title}</h3>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-200">
                          <th className="text-left py-1.5 font-medium text-gray-500">Label</th>
                          <th className="text-right py-1.5 font-medium text-gray-500">Trades</th>
                          <th className="text-right py-1.5 font-medium text-gray-500">Win%</th>
                          <th className="text-right py-1.5 font-medium text-gray-500">Total P&L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.map(row => (
                          <tr key={row.label} className="border-b border-gray-100">
                            <td className="py-1.5 text-gray-900 capitalize">{row.label}</td>
                            <td className="py-1.5 text-right text-gray-700">{row.count}</td>
                            <td className={`py-1.5 text-right font-medium ${row.winRate >= 50 ? 'text-green-600' : 'text-red-600'}`}>
                              {row.winRate.toFixed(0)}%
                            </td>
                            <td className={`py-1.5 text-right font-medium ${row.totalGain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              {formatCurrency(row.totalGain)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>

              {/* Top Winners / Losers */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {[
                  { title: 'Top 5 Winners', trades: tradeAnalytics.topWinners, color: 'text-green-600' },
                  { title: 'Top 5 Losers', trades: tradeAnalytics.topLosers, color: 'text-red-600' },
                ].map(({ title, trades, color }) => (
                  <div key={title} className="card">
                    <h3 className="text-sm font-semibold text-gray-900 mb-3">{title}</h3>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-200">
                          <th className="text-left py-1.5 font-medium text-gray-500">Symbol</th>
                          <th className="text-right py-1.5 font-medium text-gray-500">Qty</th>
                          <th className="text-right py-1.5 font-medium text-gray-500">Buy</th>
                          <th className="text-right py-1.5 font-medium text-gray-500">Sell</th>
                          <th className="text-right py-1.5 font-medium text-gray-500">P&L</th>
                          <th className="text-right py-1.5 font-medium text-gray-500">Hold</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trades.map((t, i) => (
                          <tr key={i} className="border-b border-gray-100">
                            <td className="py-1.5 font-medium text-gray-900">{t.symbol}</td>
                            <td className="py-1.5 text-right text-gray-700">{t.quantity.toFixed(0)}</td>
                            <td className="py-1.5 text-right text-gray-700">${t.buyPrice.toFixed(2)}</td>
                            <td className="py-1.5 text-right text-gray-700">${t.sellPrice.toFixed(2)}</td>
                            <td className={`py-1.5 text-right font-medium ${color}`}>
                              {formatCurrency(t.realizedGain)}
                            </td>
                            <td className="py-1.5 text-right text-gray-500">{t.holdDays}d</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>

              {/* Behavioral Patterns */}
              {tradeAnalytics.patterns && (tradeAnalytics.patterns.timingPatterns.length > 0 || tradeAnalytics.patterns.symbolPatterns.length > 0) && (
                <>
                  {/* Insight Banner */}
                  <div className="card bg-blue-50 border border-blue-200">
                    <p className="text-sm font-medium text-blue-900">{tradeAnalytics.patterns.overallInsight}</p>
                    {tradeAnalytics.patterns.holdPeriodInsight && (
                      <p className="text-sm text-blue-700 mt-1">{tradeAnalytics.patterns.holdPeriodInsight}</p>
                    )}
                  </div>

                  {/* Timing Pattern Cards */}
                  {tradeAnalytics.patterns.timingPatterns.length > 0 && (
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900 mb-3">Behavioral Patterns</h3>
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {tradeAnalytics.patterns.timingPatterns.map((tp, i) => (
                          <div
                            key={i}
                            className={`card border-l-4 ${
                              tp.severity === 'warn' ? 'border-l-amber-400' :
                              tp.severity === 'strength' ? 'border-l-green-500' :
                              'border-l-blue-400'
                            }`}
                          >
                            <p className="text-sm font-semibold text-gray-900">{tp.label}</p>
                            <p className="text-xs text-gray-500 mt-0.5">{tp.description}</p>
                            <p className="text-sm text-gray-700 mt-1">{tp.detail}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Per-Symbol Breakdown Table */}
                  {tradeAnalytics.patterns.symbolPatterns.length > 0 && (
                    <div className="card">
                      <h3 className="text-sm font-semibold text-gray-900 mb-3">Per-Symbol Breakdown</h3>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-gray-200">
                              <th className="text-left py-1.5 font-medium text-gray-500">Symbol</th>
                              <th className="text-right py-1.5 font-medium text-gray-500">Trades</th>
                              <th className="text-right py-1.5 font-medium text-gray-500">Win%</th>
                              <th className="text-right py-1.5 font-medium text-gray-500">Avg Hold</th>
                              <th className="text-right py-1.5 font-medium text-gray-500">Total P&L</th>
                              <th className="text-left py-1.5 pl-3 font-medium text-gray-500">Flag</th>
                            </tr>
                          </thead>
                          <tbody>
                            {tradeAnalytics.patterns.symbolPatterns.slice(0, 20).map(sp => (
                              <tr key={sp.symbol} className="border-b border-gray-100">
                                <td className="py-1.5 font-medium text-gray-900">{sp.symbol}</td>
                                <td className="py-1.5 text-right text-gray-700">{sp.tradeCount}</td>
                                <td className={`py-1.5 text-right font-medium ${sp.winRate >= 50 ? 'text-green-600' : 'text-red-600'}`}>
                                  {sp.winRate.toFixed(0)}%
                                </td>
                                <td className="py-1.5 text-right text-gray-700">{sp.avgHoldDays.toFixed(0)}d</td>
                                <td className={`py-1.5 text-right font-medium ${sp.totalGain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                  {formatCurrency(sp.totalGain)}
                                </td>
                                <td className="py-1.5 pl-3">
                                  {sp.flag && (
                                    <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full ${
                                      sp.flag === 'overtrading' ? 'bg-amber-100 text-amber-800' :
                                      sp.flag === 'consistent loser' ? 'bg-red-100 text-red-800' :
                                      sp.flag === 'strong performer' ? 'bg-green-100 text-green-800' :
                                      'bg-gray-100 text-gray-800'
                                    }`}>
                                      {sp.flag}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          </>
          )}
          {tpView === 'journal' && (
            <>
              {/* Symbol filter */}
              <div className="mb-4">
                <input
                  type="text"
                  placeholder="Filter by symbol..."
                  value={journalSymbolFilter}
                  onChange={e => setJournalSymbolFilter(e.target.value.toUpperCase())}
                  className="px-3 py-1.5 text-sm border border-gray-200 rounded-md w-48"
                />
              </div>
              {journalLoading ? (
                <div className="flex items-center justify-center h-64">
                  <div className="text-gray-500">Loading...</div>
                </div>
              ) : journalEntries.length === 0 ? (
                <div className="card text-center py-12">
                  <p className="text-gray-500">No trades found for this period.</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {journalEntries.map((entry, i) => {
                    const isWin = entry.realizedGain !== null && entry.realizedGain >= 0;
                    return (
                      <div key={i} className="card py-2 px-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <span className="text-xs text-gray-400 w-20">{entry.sellDate}</span>
                            <span className="font-medium text-gray-900 w-14">{entry.symbol}</span>
                            <span className="text-sm text-gray-600">{entry.sellQty} @ ${entry.sellPrice.toFixed(2)}</span>
                            {entry.buyPrice && (
                              <span className="text-xs text-gray-400">from ${entry.buyPrice.toFixed(2)}</span>
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            {entry.holdDays !== null && (
                              <span className="text-xs text-gray-400">{entry.holdDays}d</span>
                            )}
                            {entry.realizedGain !== null && (
                              <span className={`text-sm font-medium ${isWin ? 'text-green-600' : 'text-red-600'}`}>
                                ${entry.realizedGain >= 0 ? '+' : ''}{entry.realizedGain.toFixed(0)}
                              </span>
                            )}
                            {entry.realizedGainPct !== null && (
                              <span className={`text-xs ${isWin ? 'text-green-600' : 'text-red-600'}`}>
                                ({entry.realizedGainPct >= 0 ? '+' : ''}{entry.realizedGainPct.toFixed(1)}%)
                              </span>
                            )}
                          </div>
                        </div>
                        {/* Context row - only show if there's context data */}
                        {(entry.regimeAtExit || entry.decisionNote) && (
                          <div className="mt-1 flex gap-3 text-xs text-gray-400">
                            {entry.regimeAtExit && <span>Regime: {entry.regimeAtExit}</span>}
                            {entry.decisionNote && <span>Decision: {entry.decisionNote}</span>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </>
      )}

      {activeTab === 'valuation' && (
        <>
          {valLoading ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-gray-500">Loading valuation data...</div>
            </div>
          ) : (
            <ValuationSection valuations={valuations} confluenceData={{
              positions: cfPositions,
              securities,
              intents: cfIntents,
              priceLevels: cfLevels,
              watchlistItems: cfWatchlistItems,
              trendIndicators: cfTrend,
              punishedSectors: cfPunishedSectors,
              earningsEvents: cfEarnings,
            }} />
          )}
        </>
      )}
    </div>
  );
}
