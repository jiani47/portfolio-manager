import { Database } from './database';
import { AIService } from './ai-service';
import { AppSettings } from '../shared/types';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Thesis Reviewer Service
 *
 * EOD batch processor that analyzes queued news against thesis criteria.
 * Generates scorecard update suggestions and observations for user approval.
 */
export class ThesisReviewerService {
  private db: Database;
  private aiService: AIService;
  private thesisDocsPath: string;

  constructor(db: Database, settings: AppSettings, thesisDocsPath?: string) {
    this.db = db;
    this.aiService = new AIService(settings);
    this.thesisDocsPath = thesisDocsPath || path.join(process.env.HOME || '', 'Documents/portfolio-manager/docs/positions');
  }

  /**
   * Process all pending thesis reviews.
   * Groups by symbol, loads thesis context, analyzes news, generates suggestions.
   */
  async processThesisReviewQueue(): Promise<{ processed: number; suggestionsGenerated: number }> {
    const queueItems = this.db.getPendingThesisReviews();

    if (queueItems.length === 0) {
      return { processed: 0, suggestionsGenerated: 0 };
    }

    // Group by symbol
    const symbolGroups = new Map<string, typeof queueItems>();
    for (const item of queueItems) {
      if (!symbolGroups.has(item.symbol)) {
        symbolGroups.set(item.symbol, []);
      }
      symbolGroups.get(item.symbol)!.push(item);
    }

    let processed = 0;
    let suggestionsGenerated = 0;

    for (const [symbol, items] of symbolGroups.entries()) {
      try {
        const result = await this.reviewSymbol(symbol, items);
        processed += items.length;
        suggestionsGenerated += result.suggestionsGenerated;

        // Mark items as processed
        for (const item of items) {
          this.db.markThesisReviewProcessed(item.id);
        }
      } catch (error) {
        console.error(`Failed to review thesis for ${symbol}:`, error);
        // Continue processing other symbols
      }
    }

    return { processed, suggestionsGenerated };
  }

  /**
   * Review a single symbol's queued news against its thesis.
   */
  private async reviewSymbol(
    symbol: string,
    queueItems: Array<{ id: string; newsId: string; securityId: string }>
  ): Promise<{ suggestionsGenerated: number }> {
    const security = this.db.findSecurityBySymbol(symbol);
    if (!security) {
      throw new Error(`Security not found: ${symbol}`);
    }

    // Load news articles
    const rawDb = this.db.getRawDb();
    const newsIds = queueItems.map(q => q.newsId);
    const newsRaw = rawDb
      .prepare(`SELECT title, snippet, published_at FROM news WHERE id IN (${newsIds.map(() => '?').join(',')})`)
      .all(...newsIds) as Array<{ title: string; snippet: string; published_at: string }>;

    // Map DB columns to camelCase
    const news = newsRaw.map(n => ({
      title: n.title,
      snippet: n.snippet,
      publishedAt: n.published_at
    }));

    // Load thesis context
    const scorecard = this.loadScorecard(symbol);
    const observations = this.db
      .getRawDb()
      .prepare(
        `
      SELECT note, observation_date as date, thesis_impact as impact
      FROM observations
      WHERE security_id = ?
      ORDER BY observation_date DESC
      LIMIT 10
    `
      )
      .all(security.id) as Array<{ note: string; date: string; impact: string }>;

    const intent = rawDb
      .prepare('SELECT tier, thesis, invalidation FROM position_intents WHERE security_id = ?')
      .get(security.id) as { tier: string; thesis: string; invalidation: string } | undefined;

    // Run AI analysis
    const suggestions = await this.aiService.reviewThesis({
      symbol,
      news,
      scorecard,
      observations,
      intent: intent || null,
    });

    // Save suggestions
    const now = new Date().toISOString();
    const sourceNewsIds = newsIds.join(',');

    for (const suggestion of suggestions) {
      this.db.saveThesisUpdateSuggestion({
        symbol,
        securityId: security.id,
        suggestionType: suggestion.suggestionType,
        criteriaNumber: suggestion.criteriaNumber || null,
        oldStatus: suggestion.oldStatus || null,
        newStatus: suggestion.newStatus || null,
        observationNote: suggestion.observationNote || null,
        thesisImpact: suggestion.thesisImpact || null,
        rationale: suggestion.rationale,
        confidence: suggestion.confidence,
        sourceNewsIds,
        suggestedAt: now,
      });
    }

    return { suggestionsGenerated: suggestions.length };
  }

  /**
   * Load scorecard from thesis markdown file.
   * Returns null if file doesn't exist or can't be parsed.
   */
  private loadScorecard(symbol: string): { bull: Array<{ label: string; status: string }>; bear: Array<{ label: string; status: string }> } | null {
    const thesisPath = path.join(this.thesisDocsPath, symbol, 'thesis.md');

    if (!fs.existsSync(thesisPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(thesisPath, 'utf-8');

      // Parse bull criteria
      const bullMatch = content.match(/## Bull Thesis([\s\S]*?)(?=## Bear Case|$)/);
      const bull: Array<{ label: string; status: string }> = [];
      if (bullMatch) {
        const rows = bullMatch[1].matchAll(/\|\s*B(\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|/g);
        for (const row of rows) {
          bull.push({
            label: row[2].trim(),
            status: row[3].trim().replace(/[📈📉⚪]/g, '').trim() || 'unknown',
          });
        }
      }

      // Parse bear criteria
      const bearMatch = content.match(/## Bear Case([\s\S]*?)(?=##|$)/);
      const bear: Array<{ label: string; status: string }> = [];
      if (bearMatch) {
        const rows = bearMatch[1].matchAll(/\|\s*B(\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|/g);
        for (const row of rows) {
          bear.push({
            label: row[2].trim(),
            status: row[3].trim().replace(/[📈📉⚪]/g, '').trim() || 'unknown',
          });
        }
      }

      return bull.length > 0 || bear.length > 0 ? { bull, bear } : null;
    } catch (error) {
      console.error(`Failed to load scorecard for ${symbol}:`, error);
      return null;
    }
  }

  /**
   * Process a single symbol on-demand (for testing or manual triggers).
   */
  async reviewSingleSymbol(symbol: string): Promise<{ suggestionsGenerated: number }> {
    const queueItems = this.db
      .getRawDb()
      .prepare(
        `
      SELECT id, news_id, security_id
      FROM thesis_review_queue
      WHERE symbol = ? AND status = 'pending'
    `
      )
      .all(symbol) as Array<{ id: string; news_id: string; security_id: string }>;

    if (queueItems.length === 0) {
      return { suggestionsGenerated: 0 };
    }

    // Map DB columns to camelCase
    const mappedQueueItems = queueItems.map(q => ({
      id: q.id,
      newsId: q.news_id,
      securityId: q.security_id
    }));

    const result = await this.reviewSymbol(symbol, mappedQueueItems);

    // Mark as processed
    for (const item of queueItems) {
      this.db.markThesisReviewProcessed(item.id);
    }

    return result;
  }
}
