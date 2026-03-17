import { useEffect, useState, useCallback } from 'react';
import type { EarningsReview } from '../../shared/types';

type FilterStatus = 'all' | 'pending' | 'decided';

export default function EarningsReviews() {
  const [reviews, setReviews] = useState<EarningsReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [selectedReview, setSelectedReview] = useState<EarningsReview | null>(null);
  const [decisionNotes, setDecisionNotes] = useState('');
  const [decision, setDecision] = useState('');

  const fetchReviews = useCallback(async () => {
    setLoading(true);
    try {
      const opts = filterStatus === 'pending' ? { pending: true } : {};
      const data = await window.electronAPI.listEarningsReviews(opts);
      const filtered = filterStatus === 'decided'
        ? data.filter((r: EarningsReview) => r.decision != null)
        : data;
      setReviews(filtered);
    } finally {
      setLoading(false);
    }
  }, [filterStatus]);

  useEffect(() => { fetchReviews(); }, [fetchReviews]);

  const openDecide = (review: EarningsReview) => {
    setSelectedReview(review);
    setDecision(review.decision || '');
    setDecisionNotes(review.decisionNotes || '');
  };

  const handleDecide = async () => {
    if (!selectedReview || !decision.trim()) return;
    await window.electronAPI.updateEarningsReview(selectedReview.id, {
      decision: decision.trim(),
      decisionNotes: decisionNotes.trim() || null,
    });
    setSelectedReview(null);
    fetchReviews();
  };

  const thesisImpactColor = (impact: string) => {
    switch (impact) {
      case 'strengthened': return 'text-green-700 bg-green-100';
      case 'neutral': return 'text-gray-600 bg-gray-100';
      case 'challenged': return 'text-red-700 bg-red-100';
      case 'invalidated': return 'text-red-800 bg-red-200';
      default: return 'text-gray-600 bg-gray-100';
    }
  };

  const isOverdue = (review: EarningsReview) => {
    if (review.decision || !review.decisionDeadline) return false;
    return new Date(review.decisionDeadline) < new Date();
  };

  // Stats
  const pending = reviews.filter(r => !r.decision).length;
  const overdue = reviews.filter(isOverdue).length;
  const challenged = reviews.filter(r => r.thesisImpact === 'challenged' || r.thesisImpact === 'invalidated').length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Earnings Reviews</h1>
        <p className="text-sm text-gray-500 mt-1">
          Post-earnings thesis checks — did the report change anything?
        </p>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Total</p>
          <p className="text-2xl font-bold text-gray-900">{reviews.length}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Pending Decision</p>
          <p className={`text-2xl font-bold ${pending > 0 ? 'text-amber-600' : 'text-gray-900'}`}>{pending}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Overdue</p>
          <p className={`text-2xl font-bold ${overdue > 0 ? 'text-red-600' : 'text-gray-900'}`}>{overdue}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Challenged / Invalidated</p>
          <p className={`text-2xl font-bold ${challenged > 0 ? 'text-red-600' : 'text-gray-900'}`}>{challenged}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        {(['all', 'pending', 'decided'] as FilterStatus[]).map(f => (
          <button
            key={f}
            onClick={() => setFilterStatus(f)}
            className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
              filterStatus === f ? 'bg-primary-50 border-primary-300 text-primary-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* List */}
      {loading ? (
        <div className="text-center py-8 text-gray-400">Loading...</div>
      ) : reviews.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg">No earnings reviews yet</p>
          <p className="text-sm mt-1">Use <code className="bg-gray-100 px-1 rounded">pm-cli.sh earnings-review &lt;symbol&gt;</code> to create one</p>
        </div>
      ) : (
        <div className="space-y-2">
          {reviews.map(review => (
            <div
              key={review.id}
              className={`bg-white rounded-lg border p-4 ${isOverdue(review) ? 'border-red-300 bg-red-50/30' : ''}`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-lg font-bold text-gray-900">{review.symbol}</span>
                  <span className="text-sm text-gray-500">{review.quarter}</span>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${thesisImpactColor(review.thesisImpact)}`}>
                    {review.thesisImpact}
                  </span>
                  {review.invalidationTriggered && (
                    <span className="px-2 py-0.5 rounded text-xs font-medium text-red-800 bg-red-200">
                      invalidation triggered
                    </span>
                  )}
                  {isOverdue(review) && (
                    <span className="px-2 py-0.5 rounded text-xs font-medium text-red-700 bg-red-100 animate-pulse">
                      OVERDUE
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {review.decision ? (
                    <span className="text-sm text-green-700 font-medium">{review.decision}</span>
                  ) : (
                    <button
                      onClick={() => openDecide(review)}
                      className="px-3 py-1.5 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700"
                    >
                      Decide
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-4 gap-4 mt-3 text-xs">
                <div>
                  <span className="text-gray-400">Earnings Date</span>
                  <p className="text-gray-700 font-medium">{review.earningsDate}</p>
                </div>
                {review.revenueActual != null && (
                  <div>
                    <span className="text-gray-400">Revenue</span>
                    <p className="text-gray-700 font-medium">
                      ${(review.revenueActual / 1e9).toFixed(2)}B
                      {review.revenueGrowthPct != null && (
                        <span className={review.revenueGrowthPct >= 0 ? 'text-green-600 ml-1' : 'text-red-600 ml-1'}>
                          {review.revenueGrowthPct >= 0 ? '+' : ''}{review.revenueGrowthPct.toFixed(1)}%
                        </span>
                      )}
                    </p>
                  </div>
                )}
                {review.epsActual != null && (
                  <div>
                    <span className="text-gray-400">EPS</span>
                    <p className="text-gray-700 font-medium">
                      ${review.epsActual.toFixed(2)}
                      {review.epsGrowthPct != null && (
                        <span className={review.epsGrowthPct >= 0 ? 'text-green-600 ml-1' : 'text-red-600 ml-1'}>
                          {review.epsGrowthPct >= 0 ? '+' : ''}{review.epsGrowthPct.toFixed(1)}%
                        </span>
                      )}
                    </p>
                  </div>
                )}
                {review.growthTrajectory && (
                  <div>
                    <span className="text-gray-400">Growth Trajectory</span>
                    <p className="text-gray-700 font-medium">{review.growthTrajectory}</p>
                  </div>
                )}
              </div>

              {review.decisionDeadline && !review.decision && (
                <p className="text-xs text-gray-400 mt-2">
                  Decision due: {new Date(review.decisionDeadline).toLocaleDateString()}
                </p>
              )}
              {review.decisionNotes && (
                <p className="text-xs text-gray-500 mt-2 italic">{review.decisionNotes}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Decision Modal */}
      {selectedReview && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6 mx-4">
            <h2 className="text-lg font-semibold text-gray-900 mb-1">
              Decide: {selectedReview.symbol} {selectedReview.quarter}
            </h2>
            <p className="text-sm text-gray-500 mb-4">
              Thesis impact: <span className={`font-medium ${thesisImpactColor(selectedReview.thesisImpact)} px-1.5 py-0.5 rounded`}>{selectedReview.thesisImpact}</span>
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Decision</label>
                <select
                  value={decision}
                  onChange={e => setDecision(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                >
                  <option value="">Select...</option>
                  <option value="hold">Hold — thesis intact</option>
                  <option value="add">Add — thesis strengthened</option>
                  <option value="reduce">Reduce — caution warranted</option>
                  <option value="exit">Exit — thesis invalidated</option>
                  <option value="watch">Watch — need more data</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={decisionNotes}
                  onChange={e => setDecisionNotes(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                  placeholder="Why this decision? What changed?"
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setSelectedReview(null)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDecide}
                disabled={!decision.trim()}
                className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50"
              >
                Save Decision
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
