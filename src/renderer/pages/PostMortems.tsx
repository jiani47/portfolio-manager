import { useEffect, useState, useCallback } from 'react';
import type { PostMortem } from '../../shared/types';

type FilterOutcome = 'all' | 'win' | 'loss';

const ERROR_TYPES = ['none', 'entry-timing', 'sizing', 'stop-discipline', 'thesis-quality', 'regime-misread', 'overtrading'];

export default function PostMortems() {
  const [postMortems, setPostMortems] = useState<PostMortem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterOutcome, setFilterOutcome] = useState<FilterOutcome>('all');
  const [selectedPM, setSelectedPM] = useState<PostMortem | null>(null);

  const fetchPostMortems = useCallback(async () => {
    setLoading(true);
    try {
      const opts = filterOutcome !== 'all' ? { outcome: filterOutcome } : {};
      const data = await window.electronAPI.listPostMortems(opts);
      setPostMortems(data);
    } finally {
      setLoading(false);
    }
  }, [filterOutcome]);

  useEffect(() => { fetchPostMortems(); }, [fetchPostMortems]);

  const handleDelete = async (id: string) => {
    await window.electronAPI.deletePostMortem(id);
    setSelectedPM(null);
    fetchPostMortems();
  };

  const outcomeColor = (outcome: string) =>
    outcome === 'win' ? 'text-green-700 bg-green-100' : 'text-red-700 bg-red-100';

  const qualityBadge = (quality: string) =>
    quality === 'good' ? 'text-green-700 bg-green-50' : 'text-red-700 bg-red-50';

  const errorTypeBadge = (type: string) => {
    if (type === 'none') return 'text-gray-500 bg-gray-100';
    return 'text-amber-700 bg-amber-100';
  };

  // Stats
  const wins = postMortems.filter(p => p.outcome === 'win').length;
  const losses = postMortems.filter(p => p.outcome === 'loss').length;
  const errorBreakdown = postMortems.reduce((acc, p) => {
    if (p.errorType !== 'none') acc[p.errorType] = (acc[p.errorType] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Post-Mortems</h1>
          <p className="text-sm text-gray-500 mt-1">
            Review closed positions — what went right, what went wrong, what to do differently
          </p>
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Total</p>
          <p className="text-2xl font-bold text-gray-900">{postMortems.length}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">W / L</p>
          <p className="text-2xl font-bold">
            <span className="text-green-700">{wins}</span>
            <span className="text-gray-400 mx-1">/</span>
            <span className="text-red-700">{losses}</span>
          </p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Win Rate</p>
          <p className="text-2xl font-bold text-gray-900">
            {postMortems.length > 0 ? Math.round((wins / postMortems.length) * 100) : 0}%
          </p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Top Error</p>
          <p className="text-lg font-bold text-amber-700">
            {Object.entries(errorBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0]?.replace('-', ' ') || 'none'}
          </p>
        </div>
      </div>

      {/* Filter */}
      <div className="flex gap-2">
        {(['all', 'win', 'loss'] as FilterOutcome[]).map(f => (
          <button
            key={f}
            onClick={() => setFilterOutcome(f)}
            className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
              filterOutcome === f ? 'bg-primary-50 border-primary-300 text-primary-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {f === 'all' ? 'All' : f === 'win' ? 'Wins' : 'Losses'}
          </button>
        ))}
      </div>

      {/* List */}
      {loading ? (
        <div className="text-center py-8 text-gray-400">Loading...</div>
      ) : postMortems.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg">No post-mortems yet</p>
          <p className="text-sm mt-1">Use <code className="bg-gray-100 px-1 rounded">pm-cli.sh post-mortem &lt;symbol&gt;</code> to create one</p>
        </div>
      ) : (
        <div className="space-y-2">
          {postMortems.map(pm => (
            <button
              key={pm.id}
              onClick={() => setSelectedPM(pm)}
              className="w-full text-left bg-white rounded-lg border p-4 hover:border-primary-300 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-lg font-bold text-gray-900">{pm.symbol}</span>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${outcomeColor(pm.outcome)}`}>
                    {pm.outcome}
                  </span>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${errorTypeBadge(pm.errorType)}`}>
                    {pm.errorType.replace('-', ' ')}
                  </span>
                </div>
                <div className="text-right">
                  <span className={`text-sm font-medium ${pm.realizedGain >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                    ${pm.realizedGain >= 0 ? '+' : ''}{pm.realizedGain.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                  <span className="text-xs text-gray-400 ml-2">{pm.holdDays}d hold</span>
                </div>
              </div>
              <p className="text-sm text-gray-600 mt-2 line-clamp-1">{pm.lessonLearned}</p>
              <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                <span>Closed {pm.closeDate}</span>
                <span>Tier: {pm.tier}</span>
                <span className={`${qualityBadge(pm.thesisQuality)} px-1.5 py-0.5 rounded`}>
                  thesis: {pm.thesisQuality}
                </span>
                <span className={`${qualityBadge(pm.executionQuality)} px-1.5 py-0.5 rounded`}>
                  execution: {pm.executionQuality}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Detail Modal */}
      {selectedPM && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-6 mx-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-bold text-gray-900">{selectedPM.symbol}</h2>
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${outcomeColor(selectedPM.outcome)}`}>
                  {selectedPM.outcome}
                </span>
              </div>
              <button onClick={() => setSelectedPM(null)} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-500">Close Date</p>
                <p className="text-sm font-medium">{selectedPM.closeDate}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-500">Realized P&L</p>
                <p className={`text-sm font-medium ${selectedPM.realizedGain >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                  ${selectedPM.realizedGain >= 0 ? '+' : ''}{selectedPM.realizedGain.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-500">Hold Period</p>
                <p className="text-sm font-medium">{selectedPM.holdDays} days</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-500">Tier / Intent</p>
                <p className="text-sm font-medium">{selectedPM.tier} — {selectedPM.originalIntent}</p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className={`rounded-lg p-2 text-center ${qualityBadge(selectedPM.thesisQuality)}`}>
                <p className="text-xs opacity-70">Thesis</p>
                <p className="text-sm font-medium">{selectedPM.thesisQuality}</p>
              </div>
              <div className={`rounded-lg p-2 text-center ${qualityBadge(selectedPM.executionQuality)}`}>
                <p className="text-xs opacity-70">Execution</p>
                <p className="text-sm font-medium">{selectedPM.executionQuality}</p>
              </div>
              <div className={`rounded-lg p-2 text-center ${errorTypeBadge(selectedPM.errorType)}`}>
                <p className="text-xs opacity-70">Error Type</p>
                <p className="text-sm font-medium">{selectedPM.errorType.replace('-', ' ')}</p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-1">Entry Thesis</h3>
                <p className="text-sm text-gray-600 bg-gray-50 rounded-lg p-3">{selectedPM.entryThesis}</p>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-1">What Happened</h3>
                <p className="text-sm text-gray-600 bg-gray-50 rounded-lg p-3">{selectedPM.whatHappened}</p>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-1">Rule Adherence</h3>
                <p className="text-sm text-gray-600 bg-gray-50 rounded-lg p-3">{selectedPM.ruleAdherence}</p>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-amber-700 mb-1">Lesson Learned</h3>
                <p className="text-sm text-amber-800 bg-amber-50 rounded-lg p-3 border border-amber-200 font-medium">
                  {selectedPM.lessonLearned}
                </p>
              </div>
            </div>

            <div className="flex justify-between items-center mt-6 pt-4 border-t">
              <button
                onClick={() => handleDelete(selectedPM.id)}
                className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              >
                Delete
              </button>
              <button
                onClick={() => setSelectedPM(null)}
                className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
