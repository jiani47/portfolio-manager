import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import PriceChart from './PriceChart';
import type { Position, PositionIntent, Security, Valuation } from '../../shared/types';

interface Props {
  symbol: string;
  name?: string;
  onClose: () => void;
  onLevelsChanged?: () => void;
}

export default function ChartModal({ symbol, name, onClose, onLevelsChanged }: Props) {
  const [activeTab, setActiveTab] = useState<'chart' | 'thesis'>('chart');
  const [position, setPosition] = useState<Position | null>(null);
  const [intent, setIntent] = useState<PositionIntent | null>(null);
  const [valuation, setValuation] = useState<Valuation | null>(null);
  const [loading, setLoading] = useState(true);
  const [multiplePositions, setMultiplePositions] = useState(false);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Fetch position, intent, and valuation data
  useEffect(() => {
    let mounted = true;

    async function fetchData() {
      setLoading(true);
      try {
        // Find security by symbol
        const security = await window.electronAPI.findSecurityBySymbol(symbol);
        if (!security || !mounted) {
          setLoading(false);
          return;
        }

        // Get all positions and filter by security
        const allPositions = await window.electronAPI.getPositions();
        const matchingPositions = allPositions.filter(p => p.securityId === security.id);

        if (matchingPositions.length === 0) {
          setLoading(false);
          return;
        }

        // Track if multiple positions exist
        setMultiplePositions(matchingPositions.length > 1);

        // Use first/primary position
        const primaryPosition = matchingPositions[0];
        setPosition(primaryPosition);

        // Get intent for this position
        const allIntents = await window.electronAPI.listPositionIntents();
        const positionIntent = allIntents.find(i => i.positionId === primaryPosition.id);
        if (positionIntent && mounted) {
          setIntent(positionIntent);
        }

        // Try to get valuation data
        try {
          const val = await window.electronAPI.getValuation(symbol);
          if (val && mounted) {
            setValuation(val);
          }
        } catch {
          // Valuation is optional, ignore errors
        }
      } catch (error) {
        console.error('Error fetching position data:', error);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    fetchData();
    return () => { mounted = false; };
  }, [symbol]);

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Modal */}
      <div
        className="relative bg-white rounded-lg shadow-xl flex flex-col"
        style={{ width: '85vw', height: '75vh', maxWidth: '1400px', maxHeight: '900px' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <div>
            <span className="text-lg font-bold text-gray-900">{symbol}</span>
            {name && <span className="text-sm text-gray-500 ml-2">{name}</span>}
          </div>

          {/* Tab Toggle */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('chart')}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                activeTab === 'chart'
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
              }`}
            >
              Chart
            </button>
            <button
              onClick={() => setActiveTab('thesis')}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                activeTab === 'thesis'
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
              }`}
            >
              Thesis
            </button>
          </div>

          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none px-2"
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 p-4 min-h-0 overflow-auto">
          {activeTab === 'chart' ? (
            <PriceChart symbol={symbol} onLevelsChanged={onLevelsChanged} />
          ) : (
            // Thesis View
            <div className="h-full">
              {loading ? (
                <div className="flex items-center justify-center h-full text-gray-500">
                  Loading thesis data...
                </div>
              ) : !position || !intent ? (
                <div className="flex items-center justify-center h-full text-gray-500">
                  No thesis recorded for {symbol}
                </div>
              ) : (
                <div className="max-w-4xl mx-auto space-y-6">
                  {/* Header with Tier */}
                  {intent.tier && (
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-2 px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-sm font-medium">
                        <span className="w-2 h-2 rounded-full bg-blue-600" />
                        {intent.tier}
                      </span>
                      {multiplePositions && (
                        <span className="text-xs text-gray-500 italic">
                          (Multiple accounts - showing primary)
                        </span>
                      )}
                    </div>
                  )}

                  {/* Valuation Panel (if available) */}
                  {valuation && valuation.pegRating && (
                    <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                      <h3 className="text-sm font-semibold text-gray-700 mb-3">Valuation</h3>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        <div>
                          <div className="text-gray-500 text-xs">PEG Rating</div>
                          <div className="font-medium text-gray-900">{valuation.pegRating}</div>
                        </div>
                        {valuation.forwardPE && (
                          <div>
                            <div className="text-gray-500 text-xs">Forward P/E</div>
                            <div className="font-medium text-gray-900">{valuation.forwardPE.toFixed(1)}</div>
                          </div>
                        )}
                        {valuation.priceToSales && (
                          <div>
                            <div className="text-gray-500 text-xs">P/S Ratio</div>
                            <div className="font-medium text-gray-900">{valuation.priceToSales.toFixed(1)}</div>
                          </div>
                        )}
                        {valuation.epsGrowthPct && (
                          <div>
                            <div className="text-gray-500 text-xs">EPS Growth</div>
                            <div className="font-medium text-gray-900">{valuation.epsGrowthPct.toFixed(1)}%</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Thesis */}
                  {intent.thesis && (
                    <div>
                      <h3 className="text-sm font-semibold text-gray-700 mb-2">Thesis</h3>
                      <div className="bg-white border border-gray-200 rounded-lg p-4 text-sm text-gray-900 whitespace-pre-wrap">
                        {intent.thesis}
                      </div>
                    </div>
                  )}

                  {/* Invalidation */}
                  {intent.invalidation && (
                    <div>
                      <h3 className="text-sm font-semibold text-gray-700 mb-2">Invalidation Criteria</h3>
                      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-gray-900 whitespace-pre-wrap">
                        {intent.invalidation}
                      </div>
                    </div>
                  )}

                  {/* Metadata Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {intent.entryStyle && (
                      <div>
                        <div className="text-xs text-gray-500 mb-1">Entry Style</div>
                        <div className="text-sm font-medium text-gray-900">{intent.entryStyle}</div>
                      </div>
                    )}
                    {intent.targetHoldPeriod && (
                      <div>
                        <div className="text-xs text-gray-500 mb-1">Target Hold Period</div>
                        <div className="text-sm font-medium text-gray-900">{intent.targetHoldPeriod}</div>
                      </div>
                    )}
                    {intent.targetAllocationPct != null && (
                      <div>
                        <div className="text-xs text-gray-500 mb-1">Target Allocation</div>
                        <div className="text-sm font-medium text-gray-900">{intent.targetAllocationPct.toFixed(1)}%</div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
