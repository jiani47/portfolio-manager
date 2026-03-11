import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  ComposedChart,
  Area,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import type { PriceHistory, PriceLevel } from '../../shared/types';

const PERIODS = [
  { label: '3M', days: 90 },
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
  { label: '3Y', days: 1095 },
];

const strengthLabel = (s: number) =>
  s >= 8 ? 'Very Strong' : s >= 6 ? 'Strong' : s >= 4 ? 'Moderate' : 'Weak';

interface Props {
  symbol: string;
  onLevelsChanged?: () => void;
}

export default function PriceChart({ symbol, onLevelsChanged }: Props) {
  const [priceData, setPriceData] = useState<PriceHistory[]>([]);
  const [levels, setLevels] = useState<PriceLevel[]>([]);
  const [period, setPeriod] = useState(180);
  const [loading, setLoading] = useState(true);
  const [addingLevel, setAddingLevel] = useState(false);
  const [newLevelPrice, setNewLevelPrice] = useState('');
  const [newLevelType, setNewLevelType] = useState<'support' | 'resistance'>('support');
  const [refreshing, setRefreshing] = useState(false);
  const chartRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [history, priceLevels] = await Promise.all([
        window.electronAPI.getPriceHistoryBySymbol(symbol, period),
        window.electronAPI.getPriceLevels(symbol),
      ]);
      setPriceData(history);
      setLevels(priceLevels);
    } finally {
      setLoading(false);
    }
  }, [symbol, period]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Chart data: sorted by date ascending, formatted for recharts
  const chartData = useMemo(() => {
    return [...priceData]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(d => ({
        date: d.date,
        close: d.closePrice,
        open: d.openPrice,
        high: d.highPrice,
        low: d.lowPrice,
        volume: d.volume,
      }));
  }, [priceData]);

  // Price domain for Y axis
  const [yMin, yMax] = useMemo(() => {
    if (chartData.length === 0) return [0, 100];
    const prices = chartData.flatMap(d => [d.high ?? d.close, d.low ?? d.close]);
    const levelPrices = levels.map(l => l.price);
    const all = [...prices, ...levelPrices];
    const min = Math.min(...all);
    const max = Math.max(...all);
    const padding = (max - min) * 0.05;
    return [min - padding, max + padding];
  }, [chartData, levels]);

  // Max volume for scaling
  const maxVolume = useMemo(() => {
    if (chartData.length === 0) return 1;
    return Math.max(...chartData.map(d => d.volume || 0), 1);
  }, [chartData]);

  // Volume data scaled to fit bottom 15% of chart
  const chartDataWithScaledVol = useMemo(() => {
    const range = yMax - yMin;
    return chartData.map(d => ({
      ...d,
      volumeScaled: d.volume ? yMin + (d.volume / maxVolume) * range * 0.15 : 0,
    }));
  }, [chartData, yMin, yMax, maxVolume]);

  const currentPrice = chartData.length > 0 ? chartData[chartData.length - 1].close : null;

  const handleDeleteLevel = async (id: string) => {
    await window.electronAPI.deletePriceLevel(id);
    setLevels(prev => prev.filter(l => l.id !== id));
    onLevelsChanged?.();
  };

  const handleUpdateStrength = async (id: string, strength: number) => {
    const clamped = Math.max(1, Math.min(10, strength));
    await window.electronAPI.updatePriceLevel(id, { strength: clamped });
    setLevels(prev => prev.map(l => l.id === id ? { ...l, strength: clamped } : l));
    onLevelsChanged?.();
  };

  const handleToggleType = async (id: string, currentType: 'support' | 'resistance') => {
    const newType = currentType === 'support' ? 'resistance' : 'support';
    await window.electronAPI.updatePriceLevel(id, { levelType: newType });
    setLevels(prev => prev.map(l => l.id === id ? { ...l, levelType: newType } : l));
    onLevelsChanged?.();
  };

  const handleAddLevel = async () => {
    const price = parseFloat(newLevelPrice);
    if (isNaN(price) || price <= 0) return;
    const level = await window.electronAPI.createPriceLevel(symbol, newLevelType, price, 5, 'manual');
    setLevels(prev => [...prev, level].sort((a, b) => a.price - b.price));
    setNewLevelPrice('');
    setAddingLevel(false);
    onLevelsChanged?.();
  };

  const handleChartClick = (e: { activeLabel?: string; chartY?: number } | null) => {
    // recharts click event - we'll use the manual add form instead for reliability
  };

  const handleRefreshLevels = async () => {
    setRefreshing(true);
    try {
      await window.electronAPI.refreshPriceLevels([symbol]);
      const updated = await window.electronAPI.getPriceLevels(symbol);
      setLevels(updated);
      onLevelsChanged?.();
    } finally {
      setRefreshing(false);
    }
  };

  const formatDate = (date: string) => {
    const d = new Date(date + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const formatCurrency = (v: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(v);

  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ payload: Record<string, number> }>; label?: string }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div className="bg-white border border-gray-200 rounded shadow-md p-2 text-xs">
        <p className="font-medium text-gray-900 mb-1">{label}</p>
        {d.open != null && <p>O: {formatCurrency(d.open)}</p>}
        {d.high != null && <p>H: {formatCurrency(d.high)}</p>}
        {d.low != null && <p>L: {formatCurrency(d.low)}</p>}
        <p className="font-medium">C: {formatCurrency(d.close)}</p>
        {d.volume != null && d.volume > 0 && (
          <p className="text-gray-500">Vol: {(d.volume / 1e6).toFixed(1)}M</p>
        )}
      </div>
    );
  };

  // Separate support and resistance for the panel
  const supportLevels = levels.filter(l => l.levelType === 'support').sort((a, b) => b.price - a.price);
  const resistanceLevels = levels.filter(l => l.levelType === 'resistance').sort((a, b) => a.price - b.price);

  return (
    <div className="flex flex-col h-full">
      {/* Period selector */}
      <div className="flex items-center gap-2 mb-3">
        {PERIODS.map(p => (
          <button
            key={p.label}
            onClick={() => setPeriod(p.days)}
            className={`px-3 py-1 text-xs font-medium rounded ${
              period === p.days
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {p.label}
          </button>
        ))}
        <span className="text-xs text-gray-400 ml-2">
          {chartData.length} data points
        </span>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-gray-400">Loading chart...</div>
      ) : chartData.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-gray-400">No price data available for {symbol}</div>
      ) : (
        <div className="flex flex-1 gap-4 min-h-0">
          {/* Chart area */}
          <div className="flex-1 min-w-0" ref={chartRef}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={chartDataWithScaledVol}
                margin={{ top: 10, right: 10, bottom: 0, left: 10 }}
                onClick={handleChartClick}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDate}
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  tickCount={8}
                  axisLine={{ stroke: '#e5e7eb' }}
                />
                <YAxis
                  domain={[yMin, yMax]}
                  tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  axisLine={{ stroke: '#e5e7eb' }}
                  width={60}
                />
                <Tooltip content={<CustomTooltip />} />

                {/* Volume bars at bottom */}
                <Bar
                  dataKey="volumeScaled"
                  fill="#e5e7eb"
                  opacity={0.4}
                  isAnimationActive={false}
                />

                {/* Price area */}
                <Area
                  type="monotone"
                  dataKey="close"
                  stroke="#3b82f6"
                  strokeWidth={1.5}
                  fill="url(#priceGradient)"
                  isAnimationActive={false}
                />

                {/* Gradient definition */}
                <defs>
                  <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.01} />
                  </linearGradient>
                </defs>

                {/* Current price line */}
                {currentPrice && (
                  <ReferenceLine
                    y={currentPrice}
                    stroke="#6b7280"
                    strokeDasharray="2 2"
                    strokeWidth={1}
                    label={{
                      value: `$${currentPrice.toFixed(2)}`,
                      position: 'right',
                      fill: '#6b7280',
                      fontSize: 10,
                    }}
                  />
                )}

                {/* Support levels */}
                {levels
                  .filter(l => l.levelType === 'support')
                  .map(l => (
                    <ReferenceLine
                      key={l.id}
                      y={l.price}
                      stroke={l.source === 'manual' ? '#059669' : '#10b981'}
                      strokeDasharray={l.source === 'manual' ? '6 3' : '4 4'}
                      strokeWidth={Math.max(1, l.strength / 4)}
                      strokeOpacity={0.3 + (l.strength / 10) * 0.7}
                      label={{
                        value: `S $${l.price.toFixed(1)} (${l.strength}/10)`,
                        position: 'left',
                        fill: '#10b981',
                        fontSize: 9,
                      }}
                    />
                  ))}

                {/* Resistance levels */}
                {levels
                  .filter(l => l.levelType === 'resistance')
                  .map(l => (
                    <ReferenceLine
                      key={l.id}
                      y={l.price}
                      stroke={l.source === 'manual' ? '#dc2626' : '#ef4444'}
                      strokeDasharray={l.source === 'manual' ? '6 3' : '4 4'}
                      strokeWidth={Math.max(1, l.strength / 4)}
                      strokeOpacity={0.3 + (l.strength / 10) * 0.7}
                      label={{
                        value: `R $${l.price.toFixed(1)} (${l.strength}/10)`,
                        position: 'left',
                        fill: '#ef4444',
                        fontSize: 9,
                      }}
                    />
                  ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* S/R Level Panel */}
          <div className="w-64 flex-shrink-0 border-l border-gray-200 pl-4 overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-900">S/R Levels</h3>
              <div className="flex gap-1">
                <button
                  onClick={() => setAddingLevel(true)}
                  className="text-xs px-2 py-0.5 bg-blue-50 text-blue-600 rounded hover:bg-blue-100"
                  title="Add level"
                >
                  + Add
                </button>
                <button
                  onClick={handleRefreshLevels}
                  disabled={refreshing}
                  className="text-xs px-2 py-0.5 bg-gray-50 text-gray-600 rounded hover:bg-gray-100 disabled:opacity-50"
                  title="Recompute from algorithm"
                >
                  {refreshing ? '...' : 'Refresh'}
                </button>
              </div>
            </div>

            {/* Add level form */}
            {addingLevel && (
              <div className="mb-3 p-2 bg-gray-50 rounded border border-gray-200">
                <div className="flex gap-1 mb-2">
                  <button
                    onClick={() => setNewLevelType('support')}
                    className={`flex-1 text-xs py-1 rounded ${newLevelType === 'support' ? 'bg-green-100 text-green-700' : 'bg-white text-gray-500'}`}
                  >
                    Support
                  </button>
                  <button
                    onClick={() => setNewLevelType('resistance')}
                    className={`flex-1 text-xs py-1 rounded ${newLevelType === 'resistance' ? 'bg-red-100 text-red-700' : 'bg-white text-gray-500'}`}
                  >
                    Resistance
                  </button>
                </div>
                <div className="flex gap-1">
                  <input
                    type="number"
                    step="0.01"
                    value={newLevelPrice}
                    onChange={e => setNewLevelPrice(e.target.value)}
                    placeholder="Price"
                    className="flex-1 text-xs px-2 py-1 border border-gray-300 rounded w-20"
                    onKeyDown={e => e.key === 'Enter' && handleAddLevel()}
                    autoFocus
                  />
                  <button onClick={handleAddLevel} className="text-xs px-2 py-1 bg-blue-600 text-white rounded">
                    Add
                  </button>
                  <button onClick={() => setAddingLevel(false)} className="text-xs px-2 py-1 text-gray-400 hover:text-gray-600">
                    ×
                  </button>
                </div>
              </div>
            )}

            {/* Resistance levels */}
            {resistanceLevels.length > 0 && (
              <div className="mb-3">
                <p className="text-xs font-medium text-red-600 mb-1">Resistance</p>
                {resistanceLevels.map(l => (
                  <LevelRow
                    key={l.id}
                    level={l}
                    currentPrice={currentPrice}
                    onDelete={handleDeleteLevel}
                    onUpdateStrength={handleUpdateStrength}
                    onToggleType={handleToggleType}
                  />
                ))}
              </div>
            )}

            {/* Support levels */}
            {supportLevels.length > 0 && (
              <div className="mb-3">
                <p className="text-xs font-medium text-green-600 mb-1">Support</p>
                {supportLevels.map(l => (
                  <LevelRow
                    key={l.id}
                    level={l}
                    currentPrice={currentPrice}
                    onDelete={handleDeleteLevel}
                    onUpdateStrength={handleUpdateStrength}
                    onToggleType={handleToggleType}
                  />
                ))}
              </div>
            )}

            {levels.length === 0 && (
              <p className="text-xs text-gray-400 mt-2">No levels. Click "Refresh" to compute or "Add" to create manually.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function LevelRow({
  level,
  currentPrice,
  onDelete,
  onUpdateStrength,
  onToggleType,
}: {
  level: PriceLevel;
  currentPrice: number | null;
  onDelete: (id: string) => void;
  onUpdateStrength: (id: string, strength: number) => void;
  onToggleType: (id: string, currentType: 'support' | 'resistance') => void;
}) {
  const distance = currentPrice
    ? ((level.price - currentPrice) / currentPrice) * 100
    : null;
  const isManual = level.source === 'manual';

  return (
    <div className="group flex items-center gap-1 py-1 px-1 rounded hover:bg-gray-50 text-xs">
      <button
        onClick={() => onToggleType(level.id, level.levelType)}
        className={`w-4 h-4 rounded-sm flex-shrink-0 flex items-center justify-center text-[9px] font-bold ${
          level.levelType === 'resistance'
            ? 'bg-red-100 text-red-600'
            : 'bg-green-100 text-green-600'
        }`}
        title={`Click to change to ${level.levelType === 'support' ? 'resistance' : 'support'}`}
      >
        {level.levelType === 'resistance' ? 'R' : 'S'}
      </button>
      <span className="font-medium text-gray-800 w-16 text-right">
        ${level.price.toFixed(1)}
      </span>
      {distance != null && (
        <span className={`w-12 text-right ${distance >= 0 ? 'text-gray-400' : 'text-gray-400'}`}>
          {distance >= 0 ? '+' : ''}{distance.toFixed(1)}%
        </span>
      )}
      <div className="flex items-center gap-0.5 ml-auto">
        <button
          onClick={() => onUpdateStrength(level.id, level.strength - 1)}
          className="text-gray-300 hover:text-gray-500 opacity-0 group-hover:opacity-100"
        >
          −
        </button>
        <span className="w-6 text-center text-gray-500" title={`${strengthLabel(level.strength)} (${level.source})`}>
          {level.strength}
        </span>
        <button
          onClick={() => onUpdateStrength(level.id, level.strength + 1)}
          className="text-gray-300 hover:text-gray-500 opacity-0 group-hover:opacity-100"
        >
          +
        </button>
      </div>
      {isManual && (
        <span className="text-[8px] text-blue-400 flex-shrink-0" title="Manually added">M</span>
      )}
      <button
        onClick={() => onDelete(level.id)}
        className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 flex-shrink-0"
        title="Delete level"
      >
        ×
      </button>
    </div>
  );
}
