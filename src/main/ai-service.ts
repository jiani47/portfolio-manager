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
} from '../shared/types';
import { v4 as uuidv4 } from 'uuid';

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

      if (this.anthropic) {
        const message = await this.anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }],
        });
        response = (message.content[0] as { text: string }).text;
      } else if (this.openai) {
        const completion = await this.openai.chat.completions.create({
          model: 'gpt-4-turbo-preview',
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }],
        });
        response = completion.choices[0]?.message?.content || '';
      } else {
        return this.generateBasicInsights(data);
      }

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
      if (this.anthropic) {
        const message = await this.anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        });
        return (message.content[0] as { text: string }).text;
      } else if (this.openai) {
        const completion = await this.openai.chat.completions.create({
          model: 'gpt-4-turbo-preview',
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        });
        return completion.choices[0]?.message?.content || this.generateBasicAnalysis(data);
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
}
