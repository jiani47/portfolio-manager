import { useEffect, useState } from 'react';
import { useThesisSuggestions } from '../hooks/useApi';
import type { ThesisUpdateSuggestion } from '../../shared/types';
import { SuggestionType, ThesisImpact, NewsCategory } from '../../shared/types';

type ViewMode = 'pending' | 'history';

export default function ThesisReview() {
  const [viewMode, setViewMode] = useState<ViewMode>('pending');
  const [selectedSymbol, setSelectedSymbol] = useState<string | undefined>(undefined);
  const [selectedSuggestion, setSelectedSuggestion] = useState<ThesisUpdateSuggestion | null>(null);
  const [symbols, setSymbols] = useState<string[]>([]);

  const { pendingSuggestions, history, loading, error, fetchPending, fetchHistory, approveSuggestion, rejectSuggestion } =
    useThesisSuggestions(selectedSymbol);

  useEffect(() => {
    if (viewMode === 'pending') {
      fetchPending();
    } else {
      fetchHistory({ limit: 50 });
    }
  }, [viewMode, selectedSymbol, fetchPending, fetchHistory]);

  // Extract unique symbols from suggestions
  useEffect(() => {
    const allSuggestions = viewMode === 'pending' ? pendingSuggestions : history;
    const uniqueSymbols = Array.from(new Set(allSuggestions.map(s => s.symbol))).sort();
    setSymbols(uniqueSymbols);
  }, [pendingSuggestions, history, viewMode]);

  const handleApprove = async (id: string) => {
    try {
      await approveSuggestion(id);
      setSelectedSuggestion(null);
    } catch (err) {
      console.error('Failed to approve suggestion:', err);
    }
  };

  const handleReject = async (id: string) => {
    try {
      await rejectSuggestion(id);
      setSelectedSuggestion(null);
    } catch (err) {
      console.error('Failed to reject suggestion:', err);
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  const suggestionTypeLabel = (type: SuggestionType) => {
    return type === SuggestionType.SCORECARD_UPDATE ? 'Scorecard Update' : 'Observation';
  };

  const suggestionTypeBadge = (type: SuggestionType) => {
    return type === SuggestionType.SCORECARD_UPDATE
      ? 'bg-blue-100 text-blue-700'
      : 'bg-purple-100 text-purple-700';
  };

  const impactColor = (impact: ThesisImpact | null) => {
    if (impact === ThesisImpact.SUPPORTS) return 'text-green-700 bg-green-50';
    if (impact === ThesisImpact.CHALLENGES) return 'text-red-700 bg-red-50';
    return 'text-gray-700 bg-gray-50';
  };

  const confidenceColor = (confidence: number) => {
    if (confidence >= 0.8) return 'text-green-700 bg-green-50';
    if (confidence >= 0.6) return 'text-blue-700 bg-blue-50';
    return 'text-amber-700 bg-amber-50';
  };

  const suggestions = viewMode === 'pending' ? pendingSuggestions : history;

  // Stats
  const totalPending = pendingSuggestions.length;
  const scorecardUpdates = pendingSuggestions.filter(s => s.suggestionType === SuggestionType.SCORECARD_UPDATE).length;
  const observations = pendingSuggestions.filter(s => s.suggestionType === SuggestionType.OBSERVATION).length;
  const avgConfidence = pendingSuggestions.length > 0
    ? Math.round((pendingSuggestions.reduce((sum, s) => sum + s.confidence, 0) / pendingSuggestions.length) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Thesis Review</h1>
          <p className="text-sm text-gray-500 mt-1">
            AI-generated thesis updates pending your review
          </p>
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Pending</p>
          <p className="text-2xl font-bold text-gray-900">{totalPending}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Scorecard</p>
          <p className="text-2xl font-bold text-blue-700">{scorecardUpdates}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Observations</p>
          <p className="text-2xl font-bold text-purple-700">{observations}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Avg Confidence</p>
          <p className="text-2xl font-bold text-gray-900">{avgConfidence}%</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-4 items-center">
        <div className="flex gap-2">
          <button
            onClick={() => setViewMode('pending')}
            className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
              viewMode === 'pending'
                ? 'bg-primary-50 border-primary-300 text-primary-700'
                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            Pending
          </button>
          <button
            onClick={() => setViewMode('history')}
            className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
              viewMode === 'history'
                ? 'bg-primary-50 border-primary-300 text-primary-700'
                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            History
          </button>
        </div>

        {symbols.length > 0 && (
          <div className="flex gap-2 items-center">
            <span className="text-sm text-gray-500">Symbol:</span>
            <select
              value={selectedSymbol || 'all'}
              onChange={e => setSelectedSymbol(e.target.value === 'all' ? undefined : e.target.value)}
              className="px-2 py-1 text-sm border border-gray-200 rounded-lg bg-white"
            >
              <option value="all">All</option>
              {symbols.map(sym => (
                <option key={sym} value={sym}>
                  {sym}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Main content */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-lg">
          Error: {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : suggestions.length === 0 ? (
        <div className="bg-white rounded-lg border p-8 text-center">
          <p className="text-gray-500">
            {viewMode === 'pending' ? 'No pending suggestions' : 'No history available'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-6">
          {/* List */}
          <div className="space-y-3">
            {suggestions.map(suggestion => (
              <div
                key={suggestion.id}
                onClick={() => setSelectedSuggestion(suggestion)}
                className={`bg-white rounded-lg border p-4 cursor-pointer transition-all ${
                  selectedSuggestion?.id === suggestion.id
                    ? 'ring-2 ring-primary-500 border-primary-300'
                    : 'hover:border-gray-300'
                }`}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-gray-900">{suggestion.symbol}</span>
                    <span className={`px-2 py-0.5 text-xs font-medium rounded ${suggestionTypeBadge(suggestion.suggestionType)}`}>
                      {suggestionTypeLabel(suggestion.suggestionType)}
                    </span>
                  </div>
                  <span className={`px-2 py-0.5 text-xs font-medium rounded ${confidenceColor(suggestion.confidence)}`}>
                    {Math.round(suggestion.confidence * 100)}%
                  </span>
                </div>

                {suggestion.suggestionType === SuggestionType.SCORECARD_UPDATE && (
                  <div className="text-sm text-gray-600 mb-2">
                    Criterion #{suggestion.criteriaNumber}: {suggestion.oldStatus} → {suggestion.newStatus}
                  </div>
                )}

                {suggestion.thesisImpact && (
                  <div className="mb-2">
                    <span className={`px-2 py-0.5 text-xs font-medium rounded ${impactColor(suggestion.thesisImpact)}`}>
                      {suggestion.thesisImpact}
                    </span>
                  </div>
                )}

                <p className="text-sm text-gray-600 line-clamp-2">{suggestion.rationale}</p>

                <div className="flex items-center justify-between mt-3 pt-3 border-t">
                  <span className="text-xs text-gray-500">{formatDate(suggestion.suggestedAt)}</span>
                  {viewMode === 'history' && (
                    <span className={`px-2 py-0.5 text-xs font-medium rounded ${
                      suggestion.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'
                    }`}>
                      {suggestion.status}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Detail view */}
          <div className="sticky top-6">
            {selectedSuggestion ? (
              <div className="bg-white rounded-lg border p-6 space-y-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="text-xl font-bold text-gray-900">{selectedSuggestion.symbol}</h2>
                    <div className="flex gap-2 mt-2">
                      <span className={`px-2 py-1 text-xs font-medium rounded ${suggestionTypeBadge(selectedSuggestion.suggestionType)}`}>
                        {suggestionTypeLabel(selectedSuggestion.suggestionType)}
                      </span>
                      <span className={`px-2 py-1 text-xs font-medium rounded ${confidenceColor(selectedSuggestion.confidence)}`}>
                        {Math.round(selectedSuggestion.confidence * 100)}% confidence
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => setSelectedSuggestion(null)}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    ✕
                  </button>
                </div>

                {selectedSuggestion.suggestionType === SuggestionType.SCORECARD_UPDATE && (
                  <div className="bg-blue-50 rounded-lg p-4">
                    <p className="text-sm font-medium text-gray-700 mb-1">Criterion #{selectedSuggestion.criteriaNumber}</p>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="px-2 py-1 bg-white rounded border">{selectedSuggestion.oldStatus}</span>
                      <span className="text-gray-400">→</span>
                      <span className="px-2 py-1 bg-white rounded border font-semibold">{selectedSuggestion.newStatus}</span>
                    </div>
                  </div>
                )}

                {selectedSuggestion.observationNote && (
                  <div className="bg-purple-50 rounded-lg p-4">
                    <p className="text-sm font-medium text-gray-700 mb-2">Observation</p>
                    <p className="text-sm text-gray-900">{selectedSuggestion.observationNote}</p>
                  </div>
                )}

                {selectedSuggestion.thesisImpact && (
                  <div>
                    <p className="text-sm font-medium text-gray-700 mb-2">Thesis Impact</p>
                    <span className={`px-3 py-1 text-sm font-medium rounded ${impactColor(selectedSuggestion.thesisImpact)}`}>
                      {selectedSuggestion.thesisImpact}
                    </span>
                  </div>
                )}

                <div>
                  <p className="text-sm font-medium text-gray-700 mb-2">Rationale</p>
                  <p className="text-sm text-gray-900">{selectedSuggestion.rationale}</p>
                </div>

                {selectedSuggestion.sourceNewsIds && (
                  <div>
                    <p className="text-sm font-medium text-gray-700 mb-2">Based on news</p>
                    <p className="text-xs text-gray-500 font-mono">{selectedSuggestion.sourceNewsIds.split(',').length} article(s)</p>
                  </div>
                )}

                <div className="pt-4 border-t">
                  <p className="text-xs text-gray-500">
                    Suggested {formatDate(selectedSuggestion.suggestedAt)}
                  </p>
                  {selectedSuggestion.reviewedAt && (
                    <p className="text-xs text-gray-500 mt-1">
                      {selectedSuggestion.status} {formatDate(selectedSuggestion.reviewedAt)}
                      {selectedSuggestion.reviewedBy && ` by ${selectedSuggestion.reviewedBy}`}
                    </p>
                  )}
                </div>

                {viewMode === 'pending' && (
                  <div className="flex gap-3 pt-4 border-t">
                    <button
                      onClick={() => handleApprove(selectedSuggestion.id)}
                      className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors"
                    >
                      Approve & Apply
                    </button>
                    <button
                      onClick={() => handleReject(selectedSuggestion.id)}
                      className="flex-1 px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-lg font-medium transition-colors"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-white rounded-lg border p-8 text-center">
                <p className="text-gray-500">Select a suggestion to view details</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
