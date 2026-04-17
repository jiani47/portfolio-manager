import { useEffect, useState, useCallback } from 'react';
import type { NewsArticle } from '../../shared/types';
import { NewsCategory, NewsMateriality, NewsUrgency } from '../../shared/types';

type ViewMode = 'unanalyzed' | 'analyzed';

interface NewsAnalysis {
  id: string;
  newsId: string;
  symbol: string;
  category: NewsCategory;
  materiality: NewsMateriality;
  urgency: NewsUrgency;
  confidence: number;
  symbolsAffected: string | null;
  summary: string | null;
  analyzedAt: string;
}

interface NewsWithAnalysis extends NewsArticle {
  analysis?: NewsAnalysis;
}

export default function NewsAnalysis() {
  const [viewMode, setViewMode] = useState<ViewMode>('unanalyzed');
  const [news, setNews] = useState<NewsWithAnalysis[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<string>('all');
  const [symbols, setSymbols] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyzingSymbol, setAnalyzingSymbol] = useState<string | null>(null);
  const [stats, setStats] = useState<{
    totalUnanalyzed: number;
    totalAnalyzed: number;
    highMateriality: number;
    mediumMateriality: number;
  }>({ totalUnanalyzed: 0, totalAnalyzed: 0, highMateriality: 0, mediumMateriality: 0 });

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // Get stats first
      const statsData = await window.electronAPI.getNewsStats();
      setStats(statsData);

      if (viewMode === 'unanalyzed') {
        // Get unanalyzed news
        const unanalyzed = await window.electronAPI.getUnanalyzedNews(100);
        const mapped: NewsWithAnalysis[] = unanalyzed.map(item => ({
          id: item.id,
          symbol: item.symbol,
          title: item.title,
          snippet: item.snippet || '',
          source: '', // Not available in unanalyzed
          url: '', // Not available in unanalyzed
          publishedAt: item.publishedAt,
          fetchedAt: '', // Not needed
        }));
        setNews(mapped);

        // Extract unique symbols
        const uniqueSymbols = Array.from(new Set(mapped.map(n => n.symbol))).sort();
        setSymbols(uniqueSymbols);
      } else {
        // Get analyzed news
        const analyzed = await window.electronAPI.getAnalyzedNews({
          symbol: selectedSymbol !== 'all' ? selectedSymbol : undefined,
          limit: 100,
        });

        const mapped: NewsWithAnalysis[] = analyzed.map((row: any) => ({
          id: row.id,
          symbol: row.symbol,
          title: row.title,
          snippet: row.snippet,
          source: row.source,
          url: row.url,
          publishedAt: row.publishedAt,
          fetchedAt: row.fetchedAt,
          analysis: {
            id: row.analysisId,
            newsId: row.id,
            symbol: row.symbol,
            category: row.category as NewsCategory,
            materiality: row.materiality as NewsMateriality,
            urgency: row.urgency as NewsUrgency,
            confidence: row.confidence,
            symbolsAffected: row.symbolsAffected,
            summary: row.summary,
            analyzedAt: row.analyzedAt,
          },
        }));

        setNews(mapped);

        // Extract unique symbols
        const uniqueSymbols = Array.from(new Set(mapped.map(n => n.symbol))).sort();
        setSymbols(uniqueSymbols);
      }
    } catch (err) {
      console.error('Failed to fetch news:', err);
    } finally {
      setLoading(false);
    }
  }, [viewMode, selectedSymbol]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleAnalyzeSymbol = async (symbol: string) => {
    setAnalyzingSymbol(symbol);
    try {
      const result = await window.electronAPI.analyzeSymbolNews(symbol, 20);
      console.log(`Analyzed ${result.analyzed} articles for ${symbol}, queued ${result.queued} for thesis review`);
      // Refresh data to show newly analyzed articles
      await fetchData();
    } catch (err) {
      console.error('Failed to analyze symbol:', err);
      alert(`Failed to analyze ${symbol}: ${(err as Error).message}`);
    } finally {
      setAnalyzingSymbol(null);
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  const materialityColor = (materiality: NewsMateriality) => {
    if (materiality === NewsMateriality.HIGH) return 'bg-red-100 text-red-700';
    if (materiality === NewsMateriality.MEDIUM) return 'bg-yellow-100 text-yellow-700';
    return 'bg-gray-100 text-gray-700';
  };

  const categoryBadge = (category: NewsCategory) => {
    const colors: Record<NewsCategory, string> = {
      [NewsCategory.EARNINGS]: 'bg-purple-100 text-purple-700',
      [NewsCategory.GUIDANCE]: 'bg-blue-100 text-blue-700',
      [NewsCategory.PRODUCT]: 'bg-green-100 text-green-700',
      [NewsCategory.REGULATORY]: 'bg-orange-100 text-orange-700',
      [NewsCategory.MACRO]: 'bg-indigo-100 text-indigo-700',
      [NewsCategory.SECTOR]: 'bg-pink-100 text-pink-700',
      [NewsCategory.OTHER]: 'bg-gray-100 text-gray-700',
    };
    return colors[category] || 'bg-gray-100 text-gray-700';
  };

  const confidenceColor = (confidence: number) => {
    if (confidence >= 0.8) return 'text-green-700';
    if (confidence >= 0.6) return 'text-blue-700';
    return 'text-amber-700';
  };

  // Group by symbol
  const groupedNews = news.reduce((acc, article) => {
    if (!acc[article.symbol]) acc[article.symbol] = [];
    acc[article.symbol].push(article);
    return acc;
  }, {} as Record<string, NewsWithAnalysis[]>);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">News Analysis</h1>
          <p className="text-sm text-gray-500 mt-1">
            AI-powered news classification and analysis
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Unanalyzed</p>
          <p className="text-2xl font-bold text-gray-900">{stats.totalUnanalyzed.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Analyzed</p>
          <p className="text-2xl font-bold text-gray-900">{stats.totalAnalyzed.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">High Priority</p>
          <p className="text-2xl font-bold text-red-700">{stats.highMateriality}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-sm text-gray-500">Medium Priority</p>
          <p className="text-2xl font-bold text-yellow-700">{stats.mediumMateriality}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-4 items-center">
        <div className="flex gap-2">
          <button
            onClick={() => setViewMode('unanalyzed')}
            className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
              viewMode === 'unanalyzed'
                ? 'bg-primary-50 border-primary-300 text-primary-700'
                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            Pending Classification
          </button>
          <button
            onClick={() => setViewMode('analyzed')}
            className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
              viewMode === 'analyzed'
                ? 'bg-primary-50 border-primary-300 text-primary-700'
                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            Analyzed
          </button>
        </div>

        {viewMode === 'analyzed' && symbols.length > 0 && (
          <div className="flex gap-2 items-center">
            <span className="text-sm text-gray-500">Symbol:</span>
            <select
              value={selectedSymbol}
              onChange={e => setSelectedSymbol(e.target.value)}
              className="px-2 py-1 text-sm border border-gray-200 rounded-lg bg-white"
            >
              <option value="all">All Symbols</option>
              {symbols.map(sym => (
                <option key={sym} value={sym}>
                  {sym}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* News list */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : Object.keys(groupedNews).length === 0 ? (
        <div className="bg-white rounded-lg border p-8 text-center">
          <p className="text-gray-500">
            {viewMode === 'unanalyzed' ? 'No unanalyzed news' : 'No analyzed news'}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(groupedNews)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([symbol, articles]) => (
              <div key={symbol} className="bg-white rounded-lg border">
                <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
                  <div>
                    <h3 className="font-mono font-semibold text-gray-900">{symbol}</h3>
                    <p className="text-xs text-gray-500 mt-0.5">{articles.length} article{articles.length !== 1 ? 's' : ''}</p>
                  </div>
                  {viewMode === 'unanalyzed' && (
                    <button
                      onClick={() => handleAnalyzeSymbol(symbol)}
                      disabled={analyzingSymbol === symbol}
                      className="px-3 py-1.5 text-sm bg-primary-600 hover:bg-primary-700 disabled:bg-gray-400 text-white rounded-lg font-medium transition-colors"
                    >
                      {analyzingSymbol === symbol ? 'Analyzing...' : 'Analyze Now'}
                    </button>
                  )}
                </div>
                <div className="divide-y">
                  {articles.map(article => (
                    <div key={article.id} className="p-4 hover:bg-gray-50 transition-colors">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs text-gray-500">{formatDate(article.publishedAt)}</span>
                            <span className="text-xs text-gray-400">•</span>
                            <span className="text-xs text-gray-500">{article.source}</span>
                            {article.analysis && (
                              <>
                                <span className="text-xs text-gray-400">•</span>
                                <span className={`px-2 py-0.5 text-xs font-medium rounded ${materialityColor(article.analysis.materiality)}`}>
                                  {article.analysis.materiality.toUpperCase()}
                                </span>
                                <span className={`px-2 py-0.5 text-xs font-medium rounded ${categoryBadge(article.analysis.category)}`}>
                                  {article.analysis.category}
                                </span>
                                <span className={`text-xs font-medium ${confidenceColor(article.analysis.confidence)}`}>
                                  {Math.round(article.analysis.confidence * 100)}%
                                </span>
                              </>
                            )}
                          </div>
                          <h4 className="font-medium text-gray-900 mb-1">{article.title}</h4>
                          {article.analysis?.summary && (
                            <p className="text-sm text-gray-600 mb-2">{article.analysis.summary}</p>
                          )}
                          {article.snippet && !article.analysis?.summary && (
                            <p className="text-sm text-gray-600 mb-2 line-clamp-2">{article.snippet}</p>
                          )}
                        </div>
                        <a
                          href={article.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-shrink-0 px-3 py-1.5 text-sm text-primary-600 hover:text-primary-700 hover:bg-primary-50 rounded-lg transition-colors"
                        >
                          Read →
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
