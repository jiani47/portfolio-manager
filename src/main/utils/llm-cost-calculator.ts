import { Models } from '../config/models';

export interface LLMCostResult {
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

/**
 * Get pricing for a model by name
 */
function getModelPricing(modelName: string): { inputPer1k: number; outputPer1k: number } | null {
  // Search through all models to find matching pricing
  for (const provider of Object.values(Models)) {
    for (const model of Object.values(provider)) {
      if (model.name === modelName && model.pricing) {
        return model.pricing;
      }
    }
  }
  return null;
}

/**
 * Calculate LLM cost based on model name and token usage
 *
 * @param modelName - The model identifier (e.g., 'claude-sonnet-4-20250514')
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @returns Cost breakdown in USD
 */
export function calculateLLMCost(
  modelName: string,
  inputTokens: number,
  outputTokens: number
): LLMCostResult {
  const pricing = getModelPricing(modelName);

  if (!pricing) {
    console.warn(`[LLMCostCalculator] Unknown model: ${modelName}, using default pricing`);
    return {
      inputCost: inputTokens * 0.000001,
      outputCost: outputTokens * 0.000001,
      totalCost: (inputTokens + outputTokens) * 0.000001,
    };
  }

  const inputCost = (inputTokens / 1000) * pricing.inputPer1k;
  const outputCost = (outputTokens / 1000) * pricing.outputPer1k;
  const totalCost = inputCost + outputCost;

  return {
    inputCost,
    outputCost,
    totalCost,
  };
}

/**
 * Format cost for display
 */
export function formatCost(costUsd: number): string {
  if (costUsd < 0.001) {
    return `$${(costUsd * 1000).toFixed(3)}m`; // Show in millicents
  } else if (costUsd < 0.01) {
    return `$${(costUsd * 100).toFixed(2)}c`; // Show in cents
  } else {
    return `$${costUsd.toFixed(4)}`;
  }
}
