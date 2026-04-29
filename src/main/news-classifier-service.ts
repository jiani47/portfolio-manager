import { Database } from './database';
import { AIService } from './ai-service';
import { AppSettings, NewsMateriality } from '../shared/types';

/**
 * News Classifier Service
 *
 * Runs after every news fetch (10min intervals) to classify unanalyzed articles.
 * Lightweight, fast processing - only flags material news for EOD review.
 */
export class NewsClassifierService {
  private db: Database;
  private aiService: AIService;
  private minConfidence: number;

  constructor(db: Database, settings: AppSettings, minConfidence = 0.6) {
    this.db = db;
    this.aiService = new AIService(settings);
    this.minConfidence = minConfidence;
  }

  /**
   * Process unanalyzed news articles in batch.
   * Only processes news for current positions (not watchlist).
   * Returns count of articles analyzed and queued for thesis review.
   */
  async processUnanalyzedNews(): Promise<{ analyzed: number; queued: number }> {
    // Get symbols for current positions only
    const positionSymbols = this.getPositionSymbols();
    if (positionSymbols.length === 0) {
      return { analyzed: 0, queued: 0 };
    }

    const unanalyzedNews = this.db.getUnanalyzedNews(50); // Process up to 50 articles per run

    // Filter to only position symbols
    const positionNews = unanalyzedNews.filter(article => positionSymbols.includes(article.symbol));

    if (positionNews.length === 0) {
      return { analyzed: 0, queued: 0 };
    }

    let analyzed = 0;
    let queued = 0;

    for (const article of positionNews) {
      try {
        const classification = await this.aiService.classifyNews({
          symbol: article.symbol,
          title: article.title,
          snippet: article.snippet || '',
          publishedAt: article.publishedAt,
        });

        // Save analysis
        this.db.saveNewsAnalysis({
          newsId: article.id,
          symbol: article.symbol,
          category: classification.category,
          materiality: classification.materiality,
          urgency: classification.urgency,
          confidence: classification.confidence,
          symbolsAffected: classification.symbolsAffected.join(','),
          summary: classification.summary,
          sentiment: classification.sentiment,
          sentimentScore: classification.sentimentScore,
          readAt: null,
          analyzedAt: new Date().toISOString(),
        });

        analyzed++;

        // Queue for thesis review if material and confident
        if (
          classification.confidence >= this.minConfidence &&
          (classification.materiality === NewsMateriality.HIGH || classification.materiality === NewsMateriality.MEDIUM)
        ) {
          const security = this.db.findSecurityBySymbol(article.symbol);
          if (security) {
            this.db.addToThesisReviewQueue({
              newsId: article.id,
              symbol: article.symbol,
              securityId: security.id,
              queuedAt: new Date().toISOString(),
            });
            queued++;
          }
        }
      } catch (error) {
        console.error(`Failed to classify news article ${article.id}:`, error);
        // Continue processing other articles
      }
    }

    return { analyzed, queued };
  }

  /**
   * Manually classify all unanalyzed news for a specific symbol (for watchlist/ad-hoc use).
   */
  async classifySymbolNews(symbol: string, limit = 20): Promise<{ analyzed: number; queued: number }> {
    const rawDb = this.db.getRawDb();
    const unanalyzed = rawDb.prepare(`
      SELECT n.id, n.symbol, n.title, n.snippet, n.published_at
      FROM news n
      LEFT JOIN news_analysis na ON n.id = na.news_id
      WHERE na.id IS NULL AND n.symbol = ?
      ORDER BY n.published_at DESC
      LIMIT ?
    `).all(symbol, limit) as Array<{ id: string; symbol: string; title: string; snippet: string; published_at: string }>;

    if (unanalyzed.length === 0) {
      return { analyzed: 0, queued: 0 };
    }

    let analyzed = 0;
    let queued = 0;

    for (const article of unanalyzed) {
      try {
        const classification = await this.aiService.classifyNews({
          symbol: article.symbol,
          title: article.title,
          snippet: article.snippet || '',
          publishedAt: article.published_at,
        });

        // Save analysis
        this.db.saveNewsAnalysis({
          newsId: article.id,
          symbol: article.symbol,
          category: classification.category,
          materiality: classification.materiality,
          urgency: classification.urgency,
          confidence: classification.confidence,
          symbolsAffected: classification.symbolsAffected.join(','),
          summary: classification.summary,
          sentiment: classification.sentiment,
          sentimentScore: classification.sentimentScore,
          readAt: null,
          analyzedAt: new Date().toISOString(),
        });

        analyzed++;

        // Queue for thesis review if material and confident (only for positions)
        if (
          classification.confidence >= this.minConfidence &&
          (classification.materiality === NewsMateriality.HIGH || classification.materiality === NewsMateriality.MEDIUM)
        ) {
          const security = this.db.findSecurityBySymbol(article.symbol);
          if (security) {
            // Check if this is a position (not just watchlist)
            const hasPosition = rawDb.prepare(`
              SELECT COUNT(*) as count FROM positions WHERE security_id = ? AND quantity != 0
            `).get(security.id) as { count: number };

            if (hasPosition.count > 0) {
              this.db.addToThesisReviewQueue({
                newsId: article.id,
                symbol: article.symbol,
                securityId: security.id,
                queuedAt: new Date().toISOString(),
              });
              queued++;
            }
          }
        }
      } catch (error) {
        console.error(`Failed to classify news article ${article.id}:`, error);
        // Continue processing other articles
      }
    }

    return { analyzed, queued };
  }

  /**
   * Classify a single news article immediately (for real-time/on-demand use).
   */
  async classifySingleArticle(newsId: string): Promise<void> {
    const rawDb = this.db.getRawDb();
    const article = rawDb
      .prepare('SELECT id, symbol, title, snippet, published_at FROM news WHERE id = ?')
      .get(newsId) as { id: string; symbol: string; title: string; snippet: string; published_at: string } | undefined;

    if (!article) {
      throw new Error('Article not found');
    }

    const classification = await this.aiService.classifyNews({
      symbol: article.symbol,
      title: article.title,
      snippet: article.snippet || '',
      publishedAt: article.published_at,
    });

    this.db.saveNewsAnalysis({
      newsId: article.id,
      symbol: article.symbol,
      category: classification.category,
      materiality: classification.materiality,
      urgency: classification.urgency,
      confidence: classification.confidence,
      symbolsAffected: classification.symbolsAffected.join(','),
      summary: classification.summary,
      sentiment: classification.sentiment,
      sentimentScore: classification.sentimentScore,
      readAt: null,
      analyzedAt: new Date().toISOString(),
    });

    // Queue if material
    if (
      classification.confidence >= this.minConfidence &&
      (classification.materiality === NewsMateriality.HIGH || classification.materiality === NewsMateriality.MEDIUM)
    ) {
      const security = this.db.findSecurityBySymbol(article.symbol);
      if (security) {
        this.db.addToThesisReviewQueue({
          newsId: article.id,
          symbol: article.symbol,
          securityId: security.id,
          queuedAt: new Date().toISOString(),
        });
      }
    }
  }

  /**
   * Update min confidence threshold (for testing/tuning).
   */
  setMinConfidence(minConfidence: number): void {
    this.minConfidence = minConfidence;
  }

  /**
   * Get symbols for current positions (non-cash).
   */
  private getPositionSymbols(): string[] {
    const rawDb = this.db.getRawDb();
    const rows = rawDb.prepare(`
      SELECT DISTINCT s.symbol
      FROM positions p
      JOIN securities s ON p.security_id = s.id
      WHERE s.symbol != 'USD' AND p.quantity != 0
    `).all() as Array<{ symbol: string }>;
    return rows.map(r => r.symbol);
  }
}
