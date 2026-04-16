/**
 * Model Configuration with Pricing
 *
 * Prices are per 1K tokens (input and output)
 * Updated: 2025-01-29 (adapted from landmark-core)
 *
 * Sources:
 * - Anthropic: https://www.anthropic.com/pricing
 * - OpenAI: https://openai.com/pricing
 */

export const Models = {
  Anthropic: {
    ClaudeSonnet: {
      name: 'claude-sonnet-4-20250514',
      contextWindow: 200000,
      averageTokensPerChar: 0.23,
      pricing: {
        inputPer1k: 0.003, // $3.00 per million tokens
        outputPer1k: 0.015, // $15.00 per million tokens
      },
    },
    ClaudeHaiku: {
      name: 'claude-3-5-haiku-20250219',
      contextWindow: 200000,
      averageTokensPerChar: 0.23,
      pricing: {
        inputPer1k: 0.001, // $1.00 per million tokens
        outputPer1k: 0.005, // $5.00 per million tokens
      },
    },
    ClaudeOpus: {
      name: 'claude-opus-4-20250514', // Future model
      contextWindow: 200000,
      averageTokensPerChar: 0.23,
      pricing: {
        inputPer1k: 0.015, // $15.00 per million tokens (estimated)
        outputPer1k: 0.075, // $75.00 per million tokens (estimated)
      },
    },
  },
  OpenAI: {
    GPT4o: {
      name: 'gpt-4o',
      contextWindow: 128000,
      averageTokensPerChar: 0.25,
      pricing: {
        inputPer1k: 0.005, // $5.00 per million tokens
        outputPer1k: 0.015, // $15.00 per million tokens
      },
    },
    GPT4oMini: {
      name: 'gpt-4o-mini',
      contextWindow: 128000,
      averageTokensPerChar: 0.25,
      pricing: {
        inputPer1k: 0.00015, // $0.15 per million tokens
        outputPer1k: 0.0006, // $0.60 per million tokens
      },
    },
    GPT4Turbo: {
      name: 'gpt-4-turbo-preview',
      contextWindow: 128000,
      averageTokensPerChar: 0.25,
      pricing: {
        inputPer1k: 0.01, // $10.00 per million tokens
        outputPer1k: 0.03, // $30.00 per million tokens
      },
    },
  },
} as const;

export type ModelName = string; // Union of all model names

export type ModelProvider = 'anthropic' | 'openai' | 'unknown';

export function getModelProvider(modelName: string): ModelProvider {
  for (const model of Object.values(Models.Anthropic)) {
    if (model.name === modelName) return 'anthropic';
  }
  for (const model of Object.values(Models.OpenAI)) {
    if (model.name === modelName) return 'openai';
  }
  return 'unknown';
}

interface FallbackConfig {
  upgradeWithinProvider: string[];
  crossProviderFallback: string;
}

export const FallbackChains: Record<string, FallbackConfig> = {
  [Models.Anthropic.ClaudeHaiku.name]: {
    upgradeWithinProvider: [Models.Anthropic.ClaudeSonnet.name],
    crossProviderFallback: Models.OpenAI.GPT4oMini.name,
  },
  [Models.Anthropic.ClaudeSonnet.name]: {
    upgradeWithinProvider: [Models.Anthropic.ClaudeOpus.name],
    crossProviderFallback: Models.OpenAI.GPT4o.name,
  },
  [Models.Anthropic.ClaudeOpus.name]: {
    upgradeWithinProvider: [],
    crossProviderFallback: Models.OpenAI.GPT4o.name,
  },
};

export function getFallbackModels(modelName: string): { model: string; provider: ModelProvider }[] {
  const chain = FallbackChains[modelName];
  if (!chain) return [];

  const result: { model: string; provider: ModelProvider }[] = [];
  for (const upgrade of chain.upgradeWithinProvider) {
    result.push({ model: upgrade, provider: 'anthropic' });
  }
  result.push({ model: chain.crossProviderFallback, provider: getModelProvider(chain.crossProviderFallback) });
  return result;
}

/**
 * Default thinking budgets for different task types (Anthropic extended thinking).
 *
 * Budget guidelines:
 * - 10K tokens: Complex multi-step reasoning
 * - 8K tokens: Moderate complexity
 * - 6K tokens: Simple validation
 *
 * Note: Opus with thinking is ~5x more expensive than Sonnet - use judiciously.
 */
export const ThinkingBudgets = {
  /** Deep thesis analysis with multi-factor validation */
  thesisReview: 10000,
  /** Portfolio analysis with risk assessment */
  portfolioAnalysis: 8000,
  /** News classification with context */
  newsAnalysis: 6000,
  /** Simple validation checks */
  validation: 6000,
} as const;
