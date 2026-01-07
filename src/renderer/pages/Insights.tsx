import { useEffect, useState } from 'react';
import { useAI, useSettings } from '../hooks/useApi';
import type { AIInsight } from '../../shared/types';

export default function Insights() {
  const { insights, analysis, loading, error, generateInsights, analyzePortfolio } = useAI();
  const { settings, fetchSettings } = useSettings();
  const [activeTab, setActiveTab] = useState<'insights' | 'analysis'>('insights');
  const [dismissedInsights, setDismissedInsights] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const handleGenerateInsights = async () => {
    await generateInsights();
  };

  const handleAnalyzePortfolio = async () => {
    await analyzePortfolio();
  };

  const handleDismiss = (id: string) => {
    setDismissedInsights(prev => new Set([...prev, id]));
  };

  const visibleInsights = insights.filter(i => !dismissedInsights.has(i.id));

  const getSeverityColor = (severity: AIInsight['severity']) => {
    switch (severity) {
      case 'critical':
        return 'border-red-500 bg-red-50';
      case 'warning':
        return 'border-yellow-500 bg-yellow-50';
      default:
        return 'border-blue-500 bg-blue-50';
    }
  };

  const getSeverityIcon = (severity: AIInsight['severity']) => {
    switch (severity) {
      case 'critical':
        return (
          <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        );
      case 'warning':
        return (
          <svg className="w-5 h-5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
      default:
        return (
          <svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
    }
  };

  const getTypeIcon = (type: AIInsight['type']) => {
    switch (type) {
      case 'performance':
        return '📈';
      case 'risk':
        return '⚠️';
      case 'tax':
        return '💰';
      case 'allocation':
        return '🎯';
      case 'activity':
        return '📊';
      default:
        return '💡';
    }
  };

  const isAIConfigured = settings?.aiProvider !== 'none' && settings?.aiApiKey;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">AI Insights</h1>
        <div className="flex gap-3">
          <button
            onClick={handleGenerateInsights}
            disabled={loading}
            className="btn-secondary"
          >
            {loading ? 'Generating...' : 'Generate Insights'}
          </button>
          <button
            onClick={handleAnalyzePortfolio}
            disabled={loading}
            className="btn-primary"
          >
            {loading ? 'Analyzing...' : 'Full Analysis'}
          </button>
        </div>
      </div>

      {/* AI Configuration Notice */}
      {!isAIConfigured && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex gap-3">
            <svg className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <h3 className="font-medium text-yellow-800">AI Provider Not Configured</h3>
              <p className="text-sm text-yellow-700 mt-1">
                Configure an AI provider (OpenAI or Anthropic) in Settings to get AI-powered insights.
                Basic rule-based insights are still available.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-8">
          <button
            onClick={() => setActiveTab('insights')}
            className={`pb-4 text-sm font-medium border-b-2 ${
              activeTab === 'insights'
                ? 'border-primary-600 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Quick Insights
          </button>
          <button
            onClick={() => setActiveTab('analysis')}
            className={`pb-4 text-sm font-medium border-b-2 ${
              activeTab === 'analysis'
                ? 'border-primary-600 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Full Analysis
          </button>
        </nav>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Insights Tab */}
      {activeTab === 'insights' && (
        <div className="space-y-4">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto mb-4"></div>
                <p className="text-gray-500">Analyzing your portfolio...</p>
              </div>
            </div>
          ) : visibleInsights.length === 0 ? (
            <div className="card text-center py-12">
              <div className="text-4xl mb-4">💡</div>
              <p className="text-gray-500">No insights yet.</p>
              <p className="text-sm text-gray-400 mt-1">
                Click "Generate Insights" to analyze your portfolio.
              </p>
            </div>
          ) : (
            visibleInsights.map((insight) => (
              <div
                key={insight.id}
                className={`border-l-4 rounded-lg p-4 ${getSeverityColor(insight.severity)}`}
              >
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0 mt-0.5">
                    {getSeverityIcon(insight.severity)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span>{getTypeIcon(insight.type)}</span>
                      <h3 className="font-medium text-gray-900">{insight.title}</h3>
                      <span className="badge badge-info capitalize">{insight.type}</span>
                    </div>
                    <p className="text-sm text-gray-700 mb-2">{insight.summary}</p>
                    <p className="text-sm text-gray-600">{insight.details}</p>
                  </div>
                  <button
                    onClick={() => handleDismiss(insight.id)}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Analysis Tab */}
      {activeTab === 'analysis' && (
        <div className="card">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto mb-4"></div>
                <p className="text-gray-500">Generating comprehensive analysis...</p>
              </div>
            </div>
          ) : analysis ? (
            <div className="prose max-w-none">
              <div className="whitespace-pre-wrap text-gray-700 leading-relaxed">
                {analysis.split('\n').map((line, i) => {
                  if (line.startsWith('# ')) {
                    return <h1 key={i} className="text-xl font-bold text-gray-900 mt-6 mb-3">{line.slice(2)}</h1>;
                  } else if (line.startsWith('## ')) {
                    return <h2 key={i} className="text-lg font-semibold text-gray-800 mt-5 mb-2">{line.slice(3)}</h2>;
                  } else if (line.startsWith('- **')) {
                    const [label, ...rest] = line.slice(3).split('**:');
                    return (
                      <p key={i} className="ml-4 my-1">
                        <span className="font-semibold">{label}</span>: {rest.join('**:')}
                      </p>
                    );
                  } else if (line.startsWith('- ')) {
                    return <p key={i} className="ml-4 my-1">• {line.slice(2)}</p>;
                  } else if (line.startsWith('*')) {
                    return <p key={i} className="text-sm text-gray-500 italic mt-4">{line.slice(1, -1)}</p>;
                  } else if (line.match(/^\d+\./)) {
                    return <p key={i} className="ml-4 my-1">{line}</p>;
                  } else if (line.trim()) {
                    return <p key={i} className="my-2">{line}</p>;
                  }
                  return null;
                })}
              </div>
            </div>
          ) : (
            <div className="text-center py-12">
              <div className="text-4xl mb-4">📊</div>
              <p className="text-gray-500">No analysis yet.</p>
              <p className="text-sm text-gray-400 mt-1">
                Click "Full Analysis" to get a comprehensive portfolio review.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
