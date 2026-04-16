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
   * Returns count of articles analyzed and queued for thesis review.
   */
  async processUnanalyzedNews(): Promise<{ analyzed: number; queued: number }> {
    const unanalyzedNews = this.db.getUnanalyzedNews(50); // Process up to 50 articles per run

    if (unanalyzedNews.length === 0) {
      return { analyzed: 0, queued: 0 };
    }

    let analyzed = 0;
    let queued = 0;

    for (const article of unanalyzedNews) {
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
}
