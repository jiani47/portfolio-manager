import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
  AppSettings,
  AIInsight,
  Position,
  Transaction,
  TaxLot,
  Security,
  Account,
  PortfolioSummary,
  AssetAllocation,
  NewsCategory,
  NewsMateriality,
  NewsUrgency,
  NewsSentiment,
  SuggestionType,
  ThesisImpact,
} from '../shared/types';
import { v4 as uuidv4 } from 'uuid';
import { Models } from './config/models';
import { calculateLLMCost, formatCost } from './utils/llm-cost-calculator';

// Budget thresholds for cost warnings
const BUDGET_WARNING_PER_CALL = 0.50; // $0.50 per individual LLM call
const BUDGET_CRITICAL_PER_CALL = 2.00; // $2.00 per individual LLM call

interface PortfolioData {
  positions: Position[];
  transactions: Transaction[];
  taxLots: TaxLot[];
  securities: Security[];
  accounts: Account[];
}

interface AnalysisData {
  positions: Position[];
  transactions: Transaction[];
  summary: PortfolioSummary;
  allocation: AssetAllocation[];
  securities: Security[];
}

export class AIService {
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;
  private provider: 'openai' | 'anthropic' | 'none' = 'none';

  constructor(settings: AppSettings) {
    this.configure(settings);
  }

  configure(settings: AppSettings): void {
    this.provider = settings.aiProvider;

    if (settings.aiProvider === 'anthropic' && settings.aiApiKey) {
      this.anthropic = new Anthropic({ apiKey: settings.aiApiKey });
      this.openai = null;
    } else if (settings.aiProvider === 'openai' && settings.aiApiKey) {
      this.openai = new OpenAI({ apiKey: settings.aiApiKey });
      this.anthropic = null;
    } else {
      this.anthropic = null;
      this.openai = null;
    }
  }

  async generateInsights(data: PortfolioData): Promise<AIInsight[]> {
    if (this.provider === 'none' || (!this.anthropic && !this.openai)) {
      return this.generateBasicInsights(data);
    }

    const prompt = this.buildInsightsPrompt(data);

    try {
      let response: string;

      let inputTokens = 0;
      let outputTokens = 0;
      let modelUsed = '';

      if (this.anthropic) {
        modelUsed = Models.Anthropic.ClaudeSonnet.name;
        const message = await this.anthropic.messages.create({
          model: modelUsed,
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }],
        });
        response = (message.content[0] as { text: string }).text;
        inputTokens = message.usage.input_tokens;
        outputTokens = message.usage.output_tokens;
      } else if (this.openai) {
        modelUsed = Models.OpenAI.GPT4Turbo.name;
        const completion = await this.openai.chat.completions.create({
          model: modelUsed,
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }],
        });
        response = completion.choices[0]?.message?.content || '';
        inputTokens = completion.usage?.prompt_tokens || 0;
        outputTokens = completion.usage?.completion_tokens || 0;
      } else {
        return this.generateBasicInsights(data);
      }

      // Log cost
      const cost = calculateLLMCost(modelUsed, inputTokens, outputTokens);
      console.log(
        `[AI] generateInsights: ${formatCost(cost.totalCost)} (${inputTokens}+${outputTokens} tokens, model: ${modelUsed})`
      );
      this.warnIfExpensive(cost.totalCost, 'generateInsights');

      return this.parseInsightsResponse(response);
    } catch (error) {
      console.error('AI insights error:', error);
      return this.generateBasicInsights(data);
    }
  }

  async analyzePortfolio(data: AnalysisData): Promise<string> {
    if (this.provider === 'none' || (!this.anthropic && !this.openai)) {
      return this.generateBasicAnalysis(data);
    }

    const prompt = this.buildAnalysisPrompt(data);

    try {
      let response: string;
      let inputTokens = 0;
      let outputTokens = 0;
      let modelUsed = '';

      if (this.anthropic) {
        modelUsed = Models.Anthropic.ClaudeSonnet.name;
        const message = await this.anthropic.messages.create({
          model: modelUsed,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        });
        response = (message.content[0] as { text: string }).text;
        inputTokens = message.usage.input_tokens;
        outputTokens = message.usage.output_tokens;

        // Log cost
        const cost = calculateLLMCost(modelUsed, inputTokens, outputTokens);
        console.log(
          `[AI] analyzePortfolio: ${formatCost(cost.totalCost)} (${inputTokens}+${outputTokens} tokens, model: ${modelUsed})`
        );
        this.warnIfExpensive(cost.totalCost, 'analyzePortfolio');

        return response;
      } else if (this.openai) {
        modelUsed = Models.OpenAI.GPT4Turbo.name;
        const completion = await this.openai.chat.completions.create({
          model: modelUsed,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        });
        response = completion.choices[0]?.message?.content || this.generateBasicAnalysis(data);
        inputTokens = completion.usage?.prompt_tokens || 0;
        outputTokens = completion.usage?.completion_tokens || 0;

        // Log cost
        const cost = calculateLLMCost(modelUsed, inputTokens, outputTokens);
        console.log(
          `[AI] analyzePortfolio: ${formatCost(cost.totalCost)} (${inputTokens}+${outputTokens} tokens, model: ${modelUsed})`
        );
        this.warnIfExpensive(cost.totalCost, 'analyzePortfolio');

        return response;
      }
    } catch (error) {
      console.error('AI analysis error:', error);
    }

    return this.generateBasicAnalysis(data);
  }

  private buildInsightsPrompt(data: PortfolioData): string {
    const securityMap = new Map(data.securities.map(s => [s.id, s]));
    const accountMap = new Map(data.accounts.map(a => [a.id, a]));

    const positionsSummary = data.positions.map(p => ({
      symbol: securityMap.get(p.securityId)?.symbol || 'Unknown',
      account: accountMap.get(p.accountId)?.name || 'Unknown',
      quantity: p.quantity,
      costBasis: p.costBasis,
      marketValue: p.marketValue,
      unrealizedGain: p.unrealizedGain,
      unrealizedGainPercent: p.unrealizedGainPercent,
    }));

    const recentTransactions = data.transactions.slice(0, 50).map(t => ({
      symbol: securityMap.get(t.securityId)?.symbol || 'Unknown',
      type: t.type,
      date: t.date,
      quantity: t.quantity,
      price: t.price,
      amount: t.amount,
    }));

    const openTaxLots = data.taxLots.filter(t => t.isOpen).map(t => ({
      symbol: securityMap.get(t.securityId)?.symbol || 'Unknown',
      acquisitionDate: t.acquisitionDate,
      quantity: t.remainingQuantity,
      costBasis: t.costBasis,
      costPerShare: t.costPerShare,
    }));

    return `You are a portfolio management AI assistant. Analyze the following portfolio data and generate actionable insights for the investor. Focus on:
1. Performance observations
2. Risk concerns
3. Tax optimization opportunities
4. Asset allocation observations
5. Trading pattern analysis

Portfolio Positions:
${JSON.stringify(positionsSummary, null, 2)}

Recent Transactions (last 50):
${JSON.stringify(recentTransactions, null, 2)}

Open Tax Lots:
${JSON.stringify(openTaxLots, null, 2)}

Provide your response as a JSON array of insights with this structure:
[
  {
    "type": "performance|risk|tax|allocation|activity",
    "title": "Brief title",
    "summary": "One sentence summary",
    "details": "Detailed explanation",
    "severity": "info|warning|critical"
  }
]

Only return the JSON array, no other text.`;
  }

  private buildAnalysisPrompt(data: AnalysisData): string {
    const securityMap = new Map(data.securities.map(s => [s.id, s]));

    const positionsSummary = data.positions.map(p => ({
      symbol: securityMap.get(p.securityId)?.symbol || 'Unknown',
      type: securityMap.get(p.securityId)?.type || 'Unknown',
      quantity: p.quantity,
      costBasis: p.costBasis,
      marketValue: p.marketValue,
      unrealizedGain: p.unrealizedGain,
      unrealizedGainPercent: p.unrealizedGainPercent,
    }));

    return `You are a professional portfolio manager providing a comprehensive analysis. Analyze this portfolio and provide insights as if you were briefing a client.

Portfolio Summary:
- Total Value: $${data.summary.totalValue.toLocaleString()}
- Total Cost Basis: $${data.summary.totalCostBasis.toLocaleString()}
- Unrealized Gain/Loss: $${data.summary.totalUnrealizedGain.toLocaleString()} (${data.summary.totalUnrealizedGainPercent.toFixed(2)}%)
- Number of Positions: ${data.summary.positionCount}
- Number of Accounts: ${data.summary.accountCount}

Asset Allocation:
${data.allocation.map(a => `- ${a.category}: ${a.percentage.toFixed(1)}% ($${a.value.toLocaleString()})`).join('\n')}

Holdings:
${positionsSummary.map(p => `- ${p.symbol} (${p.type}): ${p.quantity} shares @ $${p.marketValue?.toLocaleString() || 'N/A'} (${p.unrealizedGainPercent?.toFixed(2) || 'N/A'}% gain/loss)`).join('\n')}

Please provide:
1. Executive Summary
2. Performance Analysis
3. Risk Assessment
4. Diversification Analysis
5. Key Observations
6. Recommendations

Format your response in clear sections with headers.`;
  }

  private parseInsightsResponse(response: string): AIInsight[] {
    try {
      // Try to extract JSON from the response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error('No JSON array found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.map((item: Record<string, unknown>) => ({
        id: uuidv4(),
        type: item.type || 'info',
        title: item.title || 'Insight',
        summary: item.summary || '',
        details: item.details || '',
        severity: item.severity || 'info',
        createdAt: new Date().toISOString(),
        dismissed: false,
      }));
    } catch (error) {
      console.error('Failed to parse AI response:', error);
      return [];
    }
  }

  private generateBasicInsights(data: PortfolioData): AIInsight[] {
    const insights: AIInsight[] = [];
    const now = new Date();

    // Check for concentrated positions
    const totalValue = data.positions.reduce((sum, p) => sum + (p.marketValue || 0), 0);
    for (const position of data.positions) {
      const weight = ((position.marketValue || 0) / totalValue) * 100;
      if (weight > 20 && totalValue > 0) {
        insights.push({
          id: uuidv4(),
          type: 'risk',
          title: 'Concentrated Position',
          summary: `A single position represents over ${weight.toFixed(1)}% of your portfolio.`,
          details: 'Large concentrated positions increase portfolio risk. Consider diversifying to reduce single-stock exposure.',
          severity: weight > 30 ? 'warning' : 'info',
          createdAt: now.toISOString(),
          dismissed: false,
        });
        break;
      }
    }

    // Check for tax loss harvesting opportunities
    const lossPositions = data.positions.filter(p => (p.unrealizedGain || 0) < -1000);
    if (lossPositions.length > 0) {
      insights.push({
        id: uuidv4(),
        type: 'tax',
        title: 'Tax Loss Harvesting Opportunity',
        summary: `${lossPositions.length} position(s) have significant unrealized losses.`,
        details: 'Consider harvesting losses to offset gains. Be mindful of wash sale rules when repurchasing similar securities.',
        severity: 'info',
        createdAt: now.toISOString(),
        dismissed: false,
      });
    }

    // Check for long-term capital gains opportunities
    const oneYearAgo = new Date(now);
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const nearLongTermLots = data.taxLots.filter(lot => {
      if (!lot.isOpen) return false;
      const acquisitionDate = new Date(lot.acquisitionDate);
      const daysHeld = (now.getTime() - acquisitionDate.getTime()) / (1000 * 60 * 60 * 24);
      return daysHeld >= 300 && daysHeld < 365;
    });

    if (nearLongTermLots.length > 0) {
      insights.push({
        id: uuidv4(),
        type: 'tax',
        title: 'Near Long-Term Status',
        summary: `${nearLongTermLots.length} tax lot(s) approaching long-term capital gains status.`,
        details: 'These lots will qualify for long-term capital gains rates soon. Consider waiting before selling to reduce tax liability.',
        severity: 'info',
        createdAt: now.toISOString(),
        dismissed: false,
      });
    }

    // Check transaction frequency
    const last30Days = new Date(now);
    last30Days.setDate(last30Days.getDate() - 30);
    const recentTransactions = data.transactions.filter(t => new Date(t.date) > last30Days);

    if (recentTransactions.length > 20) {
      insights.push({
        id: uuidv4(),
        type: 'activity',
        title: 'High Trading Activity',
        summary: `${recentTransactions.length} transactions in the last 30 days.`,
        details: 'High trading frequency can increase costs and tax liability. Consider a more patient approach unless actively managing for specific goals.',
        severity: 'warning',
        createdAt: now.toISOString(),
        dismissed: false,
      });
    }

    return insights;
  }

  private generateBasicAnalysis(data: AnalysisData): string {
    const { summary, allocation } = data;

    return `# Portfolio Analysis

## Executive Summary
Your portfolio has a total value of $${summary.totalValue.toLocaleString()} across ${summary.positionCount} positions in ${summary.accountCount} account(s). The portfolio has an unrealized ${summary.totalUnrealizedGain >= 0 ? 'gain' : 'loss'} of $${Math.abs(summary.totalUnrealizedGain).toLocaleString()} (${summary.totalUnrealizedGainPercent.toFixed(2)}%).

## Asset Allocation
${allocation.map(a => `- **${a.category}**: ${a.percentage.toFixed(1)}% ($${a.value.toLocaleString()})`).join('\n')}

## Observations
${allocation.length === 0 ? '- No positions to analyze.' : ''}
${allocation.length === 1 ? '- Portfolio is entirely concentrated in one asset class.' : ''}
${allocation.some(a => a.percentage > 50) ? '- Consider diversifying - one asset class represents over 50% of the portfolio.' : ''}

## Recommendations
1. Regularly review and rebalance your portfolio based on your investment goals.
2. Ensure adequate diversification across asset classes and sectors.
3. Monitor tax efficiency and consider tax-loss harvesting opportunities.
4. Review your risk tolerance periodically.

*Note: For detailed AI-powered analysis, configure an AI provider in Settings.*`;
  }

  /**
   * Classify a news article for material impact and categorization.
   * Lightweight, fast classification for real-time processing.
   */
  async classifyNews(article: {
    symbol: string;
    title: string;
    snippet: string;
    publishedAt: string;
  }): Promise<{
    category: NewsCategory;
    materiality: NewsMateriality;
    urgency: NewsUrgency;
    confidence: number;
    symbolsAffected: string[];
    summary: string;
    sentiment: NewsSentiment;
    sentimentScore: number;
  }> {
    if (this.provider === 'none' || (!this.anthropic && !this.openai)) {
      // Fallback: basic keyword matching
      return this.classifyNewsBasic(article);
    }

    const prompt = `Classify this news article for investment portfolio impact:

Symbol: ${article.symbol}
Title: ${article.title}
Snippet: ${article.snippet}
Published: ${article.publishedAt}

Classify on these dimensions:
1. Category: earnings, guidance, product, regulatory, macro, sector, other
2. Materiality: high (fundamental change), medium (notable event), low (routine news)
3. Urgency: breaking (immediate attention), high (review today), medium (review soon), low (FYI)
4. Confidence: 0-100 (how certain are you of this classification)
5. Symbols affected: which ticker symbols are materially impacted (including ${article.symbol})
6. Summary: 1 sentence summary of the key information
7. Sentiment (from shareholder perspective):
   - strong_bull: Major positive (e.g. earnings beat, new revenue stream, competitive win)
   - bull: Positive news (incremental good news)
   - neutral: Informational, no clear impact
   - bear: Negative news (incremental bad news)
   - strong_bear: Major negative (e.g. earnings miss, revenue decline, regulatory threat)
8. Sentiment score: -1.0 (very bearish) to +1.0 (very bullish)

Return ONLY a JSON object:
{
  "category": "...",
  "materiality": "...",
  "urgency": "...",
  "confidence": 0.85,
  "symbolsAffected": ["AAPL"],
  "summary": "...",
  "sentiment": "bull",
  "sentimentScore": 0.6
}`;

    try {
      let response: string;
      let inputTokens = 0;
      let outputTokens = 0;
      let modelUsed = '';

      if (this.anthropic) {
        modelUsed = Models.Anthropic.ClaudeHaiku.name; // Fast, cheap model for classification
        const message = await this.anthropic.messages.create({
          model: modelUsed,
          max_tokens: 512,
          messages: [{ role: 'user', content: prompt }],
        });
        response = (message.content[0] as { text: string }).text;
        inputTokens = message.usage.input_tokens;
        outputTokens = message.usage.output_tokens;
      } else if (this.openai) {
        modelUsed = Models.OpenAI.GPT4oMini.name; // Fast, cheap model
        const completion = await this.openai.chat.completions.create({
          model: modelUsed,
          max_tokens: 512,
          messages: [{ role: 'user', content: prompt }],
        });
        response = completion.choices[0]?.message?.content || '';
        inputTokens = completion.usage?.prompt_tokens || 0;
        outputTokens = completion.usage?.completion_tokens || 0;
      } else {
        return this.classifyNewsBasic(article);
      }

      // Log cost
      const cost = calculateLLMCost(modelUsed, inputTokens, outputTokens);
      console.log(
        `[AI] classifyNews: ${formatCost(cost.totalCost)} (${inputTokens}+${outputTokens} tokens, model: ${modelUsed})`
      );

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        category: (parsed.category as NewsCategory) || NewsCategory.OTHER,
        materiality: (parsed.materiality as NewsMateriality) || NewsMateriality.LOW,
        urgency: (parsed.urgency as NewsUrgency) || NewsUrgency.LOW,
        confidence: parsed.confidence || 0.5,
        symbolsAffected: parsed.symbolsAffected || [article.symbol],
        summary: parsed.summary || article.title,
        sentiment: (parsed.sentiment as NewsSentiment) || NewsSentiment.NEUTRAL,
        sentimentScore: parsed.sentimentScore || 0,
      };
    } catch (error) {
      console.error('News classification error:', error);
      return this.classifyNewsBasic(article);
    }
  }

  private classifyNewsBasic(article: { symbol: string; title: string; snippet: string }): {
    category: NewsCategory;
    materiality: NewsMateriality;
    urgency: NewsUrgency;
    confidence: number;
    symbolsAffected: string[];
    summary: string;
    sentiment: NewsSentiment;
    sentimentScore: number;
  } {
    const text = `${article.title} ${article.snippet}`.toLowerCase();

    let category: NewsCategory = NewsCategory.OTHER;
    if (text.includes('earnings') || text.includes('revenue') || text.includes('profit')) category = NewsCategory.EARNINGS;
    else if (text.includes('guidance') || text.includes('outlook') || text.includes('forecast')) category = NewsCategory.GUIDANCE;
    else if (text.includes('product') || text.includes('launch') || text.includes('release')) category = NewsCategory.PRODUCT;
    else if (text.includes('regulation') || text.includes('sec') || text.includes('fine')) category = NewsCategory.REGULATORY;
    else if (text.includes('fed') || text.includes('interest') || text.includes('inflation')) category = NewsCategory.MACRO;

    let materiality: NewsMateriality = NewsMateriality.LOW;
    if (category === NewsCategory.EARNINGS || category === NewsCategory.GUIDANCE) materiality = NewsMateriality.HIGH;
    else if (category === NewsCategory.REGULATORY || category === NewsCategory.PRODUCT) materiality = NewsMateriality.MEDIUM;

    // Basic sentiment detection
    let sentiment: NewsSentiment = NewsSentiment.NEUTRAL;
    let sentimentScore = 0;

    const bullishWords = ['beat', 'exceed', 'surge', 'gain', 'rise', 'growth', 'strong', 'positive', 'win', 'award'];
    const bearishWords = ['miss', 'decline', 'fall', 'loss', 'weak', 'negative', 'cut', 'fine', 'lawsuit', 'layoff'];

    const bullCount = bullishWords.filter(word => text.includes(word)).length;
    const bearCount = bearishWords.filter(word => text.includes(word)).length;

    if (bullCount > bearCount) {
      sentiment = bullCount >= 2 ? NewsSentiment.STRONG_BULL : NewsSentiment.BULL;
      sentimentScore = bullCount >= 2 ? 0.7 : 0.4;
    } else if (bearCount > bullCount) {
      sentiment = bearCount >= 2 ? NewsSentiment.STRONG_BEAR : NewsSentiment.BEAR;
      sentimentScore = bearCount >= 2 ? -0.7 : -0.4;
    }

    return {
      category,
      materiality,
      urgency: materiality === NewsMateriality.HIGH ? NewsUrgency.HIGH : NewsUrgency.MEDIUM,
      confidence: 0.4, // Low confidence for basic classification
      symbolsAffected: [article.symbol],
      summary: article.title,
      sentiment,
      sentimentScore,
    };
  }

  /**
   * Deep analysis of news against thesis criteria.
   * Used in EOD batch processing to generate update suggestions.
   */
  async reviewThesis(params: {
    symbol: string;
    news: Array<{ title: string; snippet: string; publishedAt: string }>;
    scorecard: { bull: Array<{ label: string; status: string }>; bear: Array<{ label: string; status: string }> } | null;
    observations: Array<{ note: string; date: string; impact: string }>;
    intent: { tier: string; thesis: string; invalidation: string } | null;
  }): Promise<Array<{
    suggestionType: SuggestionType;
    criteriaNumber?: string;
    oldStatus?: string;
    newStatus?: string;
    observationNote?: string;
    thesisImpact?: ThesisImpact;
    rationale: string;
    confidence: number;
  }>> {
    if (this.provider === 'none' || (!this.anthropic && !this.openai)) {
      return []; // No AI provider, no suggestions
    }

    const prompt = `Analyze news for thesis impact:

Symbol: ${params.symbol}

Thesis: ${params.intent?.thesis || 'No thesis on file'}
Invalidation: ${params.intent?.invalidation || 'None specified'}
Tier: ${params.intent?.tier || 'Unknown'}

Bull Criteria:
${params.scorecard?.bull.map((c, i) => `B${i + 1}. ${c.label} [${c.status}]`).join('\n') || 'None'}

Bear Criteria:
${params.scorecard?.bear.map((c, i) => `B${i + 1}. ${c.label} [${c.status}]`).join('\n') || 'None'}

Recent Observations:
${params.observations.slice(0, 5).map(o => `- ${o.date}: ${o.note} [${o.impact}]`).join('\n') || 'None'}

News (last 24h):
${params.news.map((n, i) => `${i + 1}. ${n.title}\n   ${n.snippet}\n   Published: ${n.publishedAt}`).join('\n\n')}

Task: Identify which bull/bear criteria are affected by this news. For each affected criterion, suggest:
1. scorecard_update: if criterion status should change (e.g., "strong" → "weak")
2. observation: if news is notable but doesn't warrant status change

Return ONLY a JSON array:
[
  {
    "suggestionType": "scorecard_update",
    "criteriaNumber": "B2",
    "oldStatus": "strong",
    "newStatus": "weak",
    "rationale": "Q4 revenue growth was 12%, below the 15% threshold in criterion B2",
    "confidence": 0.85
  },
  {
    "suggestionType": "observation",
    "observationNote": "Management announced cost-cutting measures, supporting margin expansion thesis",
    "thesisImpact": "supports",
    "rationale": "Aligns with bull thesis but no specific criterion to update",
    "confidence": 0.70
  }
]

If no criteria are affected, return empty array: []`;

    try {
      let response: string;
      let inputTokens = 0;
      let outputTokens = 0;
      let modelUsed = '';

      if (this.anthropic) {
        modelUsed = Models.Anthropic.ClaudeSonnet.name; // Full model for deep analysis
        const message = await this.anthropic.messages.create({
          model: modelUsed,
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }],
        });
        response = (message.content[0] as { text: string }).text;
        inputTokens = message.usage.input_tokens;
        outputTokens = message.usage.output_tokens;
      } else if (this.openai) {
        modelUsed = Models.OpenAI.GPT4Turbo.name;
        const completion = await this.openai.chat.completions.create({
          model: modelUsed,
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }],
        });
        response = completion.choices[0]?.message?.content || '';
        inputTokens = completion.usage?.prompt_tokens || 0;
        outputTokens = completion.usage?.completion_tokens || 0;
      } else {
        return [];
      }

      // Log cost
      const cost = calculateLLMCost(modelUsed, inputTokens, outputTokens);
      console.log(
        `[AI] reviewThesis(${params.symbol}): ${formatCost(cost.totalCost)} (${inputTokens}+${outputTokens} tokens, model: ${modelUsed})`
      );
      this.warnIfExpensive(cost.totalCost, `reviewThesis(${params.symbol})`);

      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return [];
      }

      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.error('Thesis review error:', error);
      return [];
    }
  }

  /**
   * Generate executive summary for morning briefing.
   * Synthesizes overnight events into actionable narrative.
   */
  async generateBriefingSummary(params: {
    overnightNews: Array<{ symbol: string; title: string; materiality: string }>;
    valuationChanges: Array<{ symbol: string; oldPeg: number; newPeg: number }>;
    pendingSuggestions: Array<{ symbol: string; suggestionType: string; rationale: string }>;
    monitors: Array<{ symbol: string; label: string }>;
    portfolioSymbols: string[];
  }): Promise<{
    summary: string;
    keyThemes: string[];
    focusAreas: string[];
  }> {
    if (this.provider === 'none' || (!this.anthropic && !this.openai)) {
      return this.generateBasicBriefingSummary(params);
    }

    const prompt = `Generate a morning briefing executive summary for a portfolio manager:

Portfolio symbols: ${params.portfolioSymbols.join(', ')}

Overnight News (${params.overnightNews.length} articles):
${params.overnightNews.slice(0, 10).map(n => `- ${n.symbol}: ${n.title} [${n.materiality}]`).join('\n')}

Valuation Changes:
${params.valuationChanges.map(v => `- ${v.symbol}: PEG ${v.oldPeg.toFixed(2)} → ${v.newPeg.toFixed(2)}`).join('\n') || 'None'}

Pending Thesis Reviews (${params.pendingSuggestions.length}):
${params.pendingSuggestions.slice(0, 5).map(s => `- ${s.symbol}: ${s.suggestionType} - ${s.rationale.substring(0, 80)}...`).join('\n') || 'None'}

Triggered Monitors:
${params.monitors.map(m => `- ${m.symbol}: ${m.label}`).join('\n') || 'None'}

Generate:
1. summary: 3-5 sentence executive summary highlighting what happened overnight and what requires attention today
2. keyThemes: 2-4 key themes across the portfolio (e.g., "Tech sector rotation", "Earnings reactions")
3. focusAreas: 2-3 symbols or actions to prioritize today (e.g., "Review NVDA scorecard", "Consider TSLA exit")

Return ONLY a JSON object:
{
  "summary": "Overnight, tech stocks pulled back 1.5% on rate concerns. Three holdings reported earnings...",
  "keyThemes": ["Rate sensitivity", "Earnings season"],
  "focusAreas": ["Review NVDA post-earnings", "Check AAPL valuation change"]
}`;

    try {
      let response: string;
      let inputTokens = 0;
      let outputTokens = 0;
      let modelUsed = '';

      if (this.anthropic) {
        modelUsed = Models.Anthropic.ClaudeSonnet.name;
        const message = await this.anthropic.messages.create({
          model: modelUsed,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        });
        response = (message.content[0] as { text: string }).text;
        inputTokens = message.usage.input_tokens;
        outputTokens = message.usage.output_tokens;
      } else if (this.openai) {
        modelUsed = Models.OpenAI.GPT4Turbo.name;
        const completion = await this.openai.chat.completions.create({
          model: modelUsed,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        });
        response = completion.choices[0]?.message?.content || '';
        inputTokens = completion.usage?.prompt_tokens || 0;
        outputTokens = completion.usage?.completion_tokens || 0;
      } else {
        return this.generateBasicBriefingSummary(params);
      }

      // Log cost
      const cost = calculateLLMCost(modelUsed, inputTokens, outputTokens);
      console.log(
        `[AI] generateBriefingSummary: ${formatCost(cost.totalCost)} (${inputTokens}+${outputTokens} tokens, model: ${modelUsed})`
      );
      this.warnIfExpensive(cost.totalCost, 'generateBriefingSummary');

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.error('Briefing summary error:', error);
      return this.generateBasicBriefingSummary(params);
    }
  }

  private generateBasicBriefingSummary(params: {
    overnightNews: Array<{ symbol: string; title: string; materiality: string }>;
    valuationChanges: Array<{ symbol: string; oldPeg: number; newPeg: number }>;
    pendingSuggestions: Array<{ symbol: string; suggestionType: string }>;
    monitors: Array<{ symbol: string; label: string }>;
  }): {
    summary: string;
    keyThemes: string[];
    focusAreas: string[];
  } {
    const highMaterialityNews = params.overnightNews.filter(n => n.materiality === 'high');
    const summary = [
      highMaterialityNews.length > 0
        ? `${highMaterialityNews.length} high-materiality news items overnight.`
        : 'Quiet overnight session.',
      params.pendingSuggestions.length > 0
        ? `${params.pendingSuggestions.length} thesis updates pending review.`
        : null,
      params.monitors.length > 0
        ? `${params.monitors.length} price alerts triggered.`
        : null,
    ]
      .filter(Boolean)
      .join(' ');

    const themes: string[] = [];
    if (highMaterialityNews.length > 2) themes.push('Active news flow');
    if (params.valuationChanges.length > 0) themes.push('Valuation shifts');
    if (params.pendingSuggestions.length > 3) themes.push('Thesis maintenance needed');

    const focusAreas: string[] = [];
    if (params.pendingSuggestions.length > 0) {
      const symbols = [...new Set(params.pendingSuggestions.slice(0, 2).map(s => s.symbol))];
      focusAreas.push(...symbols.map(s => `Review ${s} updates`));
    }
    if (params.monitors.length > 0) {
      focusAreas.push(`Check ${params.monitors.length} triggered monitor(s)`);
    }

    return { summary: summary || 'No significant overnight activity.', keyThemes: themes, focusAreas };
  }

  /**
   * Warn if an LLM call exceeds budget thresholds
   */
  private warnIfExpensive(cost: number, operation: string): void {
    if (cost >= BUDGET_CRITICAL_PER_CALL) {
      console.error(
        `[AI] 🚨 CRITICAL: Expensive LLM call in ${operation}: ${formatCost(cost)} (threshold: ${formatCost(BUDGET_CRITICAL_PER_CALL)})`
      );
    } else if (cost >= BUDGET_WARNING_PER_CALL) {
      console.warn(
        `[AI] ⚠️  WARNING: Expensive LLM call in ${operation}: ${formatCost(cost)} (threshold: ${formatCost(BUDGET_WARNING_PER_CALL)})`
      );
    }
  }
}
