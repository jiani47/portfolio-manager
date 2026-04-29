import { useEffect, useState, useCallback } from 'react';
import type { NewsArticle } from '../../shared/types';
import { NewsCategory, NewsMateriality, NewsSentiment } from '../../shared/types';
import SymbolAutocomplete from '../components/SymbolAutocomplete';

type ViewTab = 'queue' | 'positions' | 'watchlist' | 'search';
type SentimentFilter = 'all' | 'bullish' | 'bearish';

interface NewsAnalysis {
  id: string;
  newsId: string;
  symbol: string;
  category: NewsCategory;
  materiality: NewsMateriality;
  urgency: string;
  confidence: number;
  symbolsAffected: string | null;
  summary: string | null;
  sentiment: NewsSentiment | null;
  sentimentScore: number | null;
  readAt: string | null;
  analyzedAt: string;
}

interface NewsWithAnalysis extends NewsArticle {
  analysis?: NewsAnalysis;
  watchlistName?: string;
}

export default function NewsAnalysis() {
  const [activeTab, setActiveTab] = useState<ViewTab>('queue');
  const [news, setNews] = useState<NewsWithAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [sentimentFilter, setSentimentFilter] = useState<SentimentFilter>('all');
  const [searchSymbol, setSearchSymbol] = useState('');
  const [searchDays, setSearchDays] = useState(7);

  // For autocomplete
  const [positionSymbols, setPositionSymbols] = useState<string[]>([]);
  const [watchlistSymbols, setWatchlistSymbols] = useState<string[]>([]);

  // Stats
  const [stats, setStats] = useState({
    pending: 0,
    strongSignals: 0,
    needsReview: 0,
    dismissed: 0,
  });

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      let data: any[] = [];

      switch (activeTab) {
        case 'queue':
          data = await window.electronAPI.getTodaysQueue();
          break;
        case 'positions':
          data = await window.electronAPI.getNewsForPositions(7);
          break;
        case 'watchlist':
          data = await window.electronAPI.getNewsForWatchlist(7);
          break;
        case 'search':
          if (searchSymbol) {
            data = await window.electronAPI.getAnalyzedNews({ symbol: searchSymbol, limit: 100 });
          }
          break;
      }

      const mapped: NewsWithAnalysis[] = data.map((row: any) => ({
        id: row.id,
        symbol: row.symbol,
        title: row.title,
        snippet: row.snippet,
        source: row.source,
        url: row.url,
        publishedAt: row.publishedAt,
        fetchedAt: row.fetchedAt,
        watchlistName: row.watchlistName,
        analysis: row.analysisId ? {
          id: row.analysisId,
          newsId: row.id,
          symbol: row.symbol,
          category: row.category as NewsCategory,
          materiality: row.materiality as NewsMateriality,
          urgency: row.urgency,
          confidence: row.confidence,
          symbolsAffected: row.symbolsAffected,
          summary: row.summary,
          sentiment: row.sentiment as NewsSentiment,
          sentimentScore: row.sentimentScore,
          readAt: row.readAt,
          analyzedAt: row.analyzedAt,
        } : undefined,
      }));

      // Apply sentiment filter
      const filtered = mapped.filter(article => {
        if (sentimentFilter === 'all') return true;
        if (!article.analysis?.sentiment) return false;

        if (sentimentFilter === 'bullish') {
          return article.analysis.sentiment === NewsSentiment.BULL ||
                 article.analysis.sentiment === NewsSentiment.STRONG_BULL;
        }
        if (sentimentFilter === 'bearish') {
          return article.analysis.sentiment === NewsSentiment.BEAR ||
                 article.analysis.sentiment === NewsSentiment.STRONG_BEAR;
        }
        return true;
      });

      setNews(filtered);

      // Calculate stats for queue tab
      if (activeTab === 'queue') {
        const pending = mapped.filter(n => !n.analysis?.readAt).length;
        const strongSignals = mapped.filter(n =>
          n.analysis?.sentiment === NewsSentiment.STRONG_BULL ||
          n.analysis?.sentiment === NewsSentiment.STRONG_BEAR
        ).length;
        const needsReview = mapped.filter(n =>
          n.analysis?.materiality === NewsMateriality.HIGH && !n.analysis?.readAt
        ).length;

        setStats({
          pending,
          strongSignals,
          needsReview,
          dismissed: 0, // We don't track dismissed separately anymore
        });
      }
    } catch (err) {
      console.error('Failed to fetch news:', err);
    } finally {
      setLoading(false);
    }
  }, [activeTab, sentimentFilter, searchSymbol]);

  // Fetch position and watchlist symbols for autocomplete
  useEffect(() => {
    (async () => {
      try {
        const positions = await window.electronAPI.getPositions();
        const posSymbols = positions
          .filter(p => p.symbol && p.symbol !== 'USD')
          .map(p => p.symbol!)
          .filter((v, i, a) => a.indexOf(v) === i)
          .sort();
        setPositionSymbols(posSymbols);

        const watchlists = await window.electronAPI.getWatchlists();
        const watchSymbols: string[] = [];
        for (const wl of watchlists) {
          const items = await window.electronAPI.getWatchlistItems(wl.id);
          items.forEach(item => {
            if (!posSymbols.includes(item.symbol) && !watchSymbols.includes(item.symbol)) {
              watchSymbols.push(item.symbol);
            }
          });
        }
        setWatchlistSymbols(watchSymbols.sort());
      } catch (err) {
        console.error('Failed to fetch symbols:', err);
      }
    })();
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleMarkAsRead = async (newsId: string) => {
    try {
      await window.electronAPI.markNewsAsRead(newsId);
      await fetchData();
    } catch (err) {
      console.error('Failed to mark as read:', err);
    }
  };

  const handleMarkAllAsRead = async () => {
    try {
      const unreadIds = news.filter(n => !n.analysis?.readAt).map(n => n.id);
      if (unreadIds.length > 0) {
        await window.electronAPI.markMultipleNewsAsRead(unreadIds);
        await fetchData();
      }
    } catch (err) {
      console.error('Failed to mark all as read:', err);
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);

    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  const materialityBadge = (materiality: NewsMateriality) => {
    if (materiality === NewsMateriality.HIGH) return 'bg-red-100 text-red-700 font-medium';
    if (materiality === NewsMateriality.MEDIUM) return 'bg-yellow-100 text-yellow-700';
    return 'bg-gray-100 text-gray-600';
  };

  const categoryBadge = (category: NewsCategory) => {
    const colors: Record<NewsCategory, string> = {
      [NewsCategory.EARNINGS]: 'bg-purple-100 text-purple-700',
      [NewsCategory.GUIDANCE]: 'bg-blue-100 text-blue-700',
      [NewsCategory.PRODUCT]: 'bg-green-100 text-green-700',
      [NewsCategory.REGULATORY]: 'bg-orange-100 text-orange-700',
      [NewsCategory.MACRO]: 'bg-indigo-100 text-indigo-700',
      [NewsCategory.SECTOR]: 'bg-pink-100 text-pink-700',
      [NewsCategory.OTHER]: 'bg-gray-100 text-gray-600',
    };
    return colors[category] || 'bg-gray-100 text-gray-600';
  };

  const sentimentLabel = (sentiment: NewsSentiment | null) => {
    if (!sentiment) return { text: 'NEUTRAL', color: 'text-gray-600 bg-gray-50' };

    switch (sentiment) {
      case NewsSentiment.STRONG_BULL:
        return { text: 'STRONG BULL', color: 'text-green-700 bg-green-50 font-semibold' };
      case NewsSentiment.BULL:
        return { text: 'BULL', color: 'text-green-600 bg-green-50' };
      case NewsSentiment.BEAR:
        return { text: 'BEAR', color: 'text-red-600 bg-red-50' };
      case NewsSentiment.STRONG_BEAR:
        return { text: 'STRONG BEAR', color: 'text-red-700 bg-red-50 font-semibold' };
      default:
        return { text: 'NEUTRAL', color: 'text-gray-600 bg-gray-50' };
    }
  };

  const confidenceColor = (confidence: number) => {
    if (confidence >= 0.8) return 'text-green-700';
    if (confidence >= 0.6) return 'text-blue-700';
    return 'text-amber-600';
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
            AI-powered news classification with sentiment analysis
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-gray-200">
        <button
          onClick={() => setActiveTab('queue')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'queue'
              ? 'border-primary-600 text-primary-700'
              : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
          }`}
        >
          Today's Queue {stats.pending > 0 && <span className="ml-1 text-xs">({stats.pending})</span>}
        </button>
        <button
          onClick={() => setActiveTab('positions')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'positions'
              ? 'border-primary-600 text-primary-700'
              : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
          }`}
        >
          Positions
        </button>
        <button
          onClick={() => setActiveTab('watchlist')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'watchlist'
              ? 'border-primary-600 text-primary-700'
              : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
          }`}
        >
          Watchlist
        </button>
        <button
          onClick={() => setActiveTab('search')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'search'
              ? 'border-primary-600 text-primary-700'
              : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
          }`}
        >
          Search
        </button>
      </div>

      {/* Stats Bar (Queue tab only) */}
      {activeTab === 'queue' && (
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-white rounded-lg border p-4">
            <p className="text-sm text-gray-500">Pending</p>
            <p className="text-2xl font-bold text-gray-900">{stats.pending}</p>
          </div>
          <div className="bg-white rounded-lg border p-4">
            <p className="text-sm text-gray-500">Strong Signal</p>
            <p className="text-2xl font-bold text-purple-700">{stats.strongSignals}</p>
          </div>
          <div className="bg-white rounded-lg border p-4">
            <p className="text-sm text-gray-500">Needs Review</p>
            <p className="text-2xl font-bold text-red-700">{stats.needsReview}</p>
          </div>
          <div className="bg-white rounded-lg border p-4 flex items-center justify-center">
            <button
              onClick={handleMarkAllAsRead}
              disabled={stats.pending === 0}
              className="text-sm text-primary-600 hover:text-primary-700 disabled:text-gray-400 disabled:cursor-not-allowed font-medium"
            >
              Mark All Read
            </button>
          </div>
        </div>
      )}

      {/* Search Tab Controls */}
      {activeTab === 'search' && (
        <div className="bg-white rounded-lg border p-4 space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Symbol</label>
              <SymbolAutocomplete
                value={searchSymbol}
                onChange={setSearchSymbol}
                positions={positionSymbols}
                watchlist={watchlistSymbols}
                placeholder="Type symbol to search..."
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Date Range</label>
              <select
                value={searchDays}
                onChange={e => setSearchDays(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg"
              >
                <option value={1}>Last 24 hours</option>
                <option value={7}>Last 7 days</option>
                <option value={30}>Last 30 days</option>
                <option value={90}>Last 90 days</option>
              </select>
            </div>
          </div>
          <button
            onClick={fetchData}
            disabled={!searchSymbol}
            className="px-4 py-2 bg-primary-600 hover:bg-primary-700 disabled:bg-gray-300 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Search
          </button>
        </div>
      )}

      {/* Sentiment Filter */}
      {activeTab !== 'search' && (
        <div className="flex gap-2 items-center">
          <span className="text-sm text-gray-600">Filter:</span>
          <button
            onClick={() => setSentimentFilter('all')}
            className={`px-3 py-1 text-sm rounded-lg border transition-colors ${
              sentimentFilter === 'all'
                ? 'bg-primary-50 border-primary-300 text-primary-700'
                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            All
          </button>
          <button
            onClick={() => setSentimentFilter('bullish')}
            className={`px-3 py-1 text-sm rounded-lg border transition-colors ${
              sentimentFilter === 'bullish'
                ? 'bg-green-50 border-green-300 text-green-700'
                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            Bullish Only
          </button>
          <button
            onClick={() => setSentimentFilter('bearish')}
            className={`px-3 py-1 text-sm rounded-lg border transition-colors ${
              sentimentFilter === 'bearish'
                ? 'bg-red-50 border-red-300 text-red-700'
                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            Bearish Only
          </button>
        </div>
      )}

      {/* News list */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : Object.keys(groupedNews).length === 0 ? (
        <div className="bg-white rounded-lg border p-8 text-center">
          <p className="text-gray-500">
            {activeTab === 'queue' && 'No pending news in queue'}
            {activeTab === 'positions' && 'No news for your positions'}
            {activeTab === 'watchlist' && 'No news for watchlist symbols'}
            {activeTab === 'search' && (searchSymbol ? 'No news found' : 'Enter a symbol to search')}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(groupedNews)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([symbol, articles]) => (
              <div key={symbol} className="bg-white rounded-lg border">
                <div className="px-4 py-3 border-b bg-gray-50">
                  <h3 className="font-mono font-semibold text-gray-900">{symbol}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {articles.length} article{articles.length !== 1 ? 's' : ''}
                    {articles[0]?.watchlistName && ` · ${articles[0].watchlistName}`}
                  </p>
                </div>
                <div className="divide-y">
                  {articles.map(article => {
                    const sentiment = sentimentLabel(article.analysis?.sentiment || null);
                    return (
                      <div
                        key={article.id}
                        className={`p-4 transition-colors ${
                          article.analysis?.readAt ? 'opacity-60' : 'hover:bg-gray-50'
                        }`}
                      >
                        <div className="flex items-start gap-4">
                          <div className="flex-1 min-w-0">
                            {/* Header: Sentiment + Badges */}
                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                              <span className={`px-2 py-1 text-xs rounded ${sentiment.color}`}>
                                {sentiment.text}
                              </span>
                              <span className={`px-2 py-0.5 text-xs rounded ${materialityBadge(article.analysis?.materiality || NewsMateriality.LOW)}`}>
                                {article.analysis?.materiality?.toUpperCase() || 'LOW'}
                              </span>
                              <span className={`px-2 py-0.5 text-xs rounded ${categoryBadge(article.analysis?.category || NewsCategory.OTHER)}`}>
                                {article.analysis?.category || 'other'}
                              </span>
                              {article.analysis && (
                                <span className={`text-xs font-medium ${confidenceColor(article.analysis.confidence)}`}>
                                  {Math.round(article.analysis.confidence * 100)}%
                                </span>
                              )}
                              <span className="text-xs text-gray-500">· {formatDate(article.publishedAt)}</span>
                              {article.source && (
                                <span className="text-xs text-gray-400">· {article.source}</span>
                              )}
                            </div>

                            {/* Title */}
                            <h4 className="font-medium text-gray-900 mb-1">{article.title}</h4>

                            {/* Summary */}
                            {article.analysis?.summary && (
                              <p className="text-sm text-gray-600 mb-2">{article.analysis.summary}</p>
                            )}
                          </div>

                          {/* Actions */}
                          <div className="flex-shrink-0 flex gap-2">
                            <a
                              href={article.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="px-3 py-1.5 text-sm text-primary-600 hover:text-primary-700 hover:bg-primary-50 rounded-lg transition-colors"
                            >
                              Read
                            </a>
                            {!article.analysis?.readAt && (
                              <button
                                onClick={() => handleMarkAsRead(article.id)}
                                className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
                              >
                                Mark Read
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
