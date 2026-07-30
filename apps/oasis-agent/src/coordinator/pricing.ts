export class PricingService {
  private readonly logger = console;

  estimateUsd(
    inputTokens: number,
    outputTokens: number,
    model: string | null,
    provider?: string | null,
  ): { usd: number; known: boolean } {
    if (!model || (inputTokens <= 0 && outputTokens <= 0)) {
      return { usd: 0, known: false };
    }

    // Simplified pricing — default to $0 if model unknown
    const price = this.pricingFor(model, provider || undefined);
    if (!price) {
      return { usd: 0, known: false };
    }

    const usd =
      (inputTokens / 1_000_000) * price.input +
      (outputTokens / 1_000_000) * price.output;
    return { usd, known: true };
  }

  pricingFor(
    modelOrSlug: string,
    provider?: string,
  ): { input: number; output: number } | null {
    // Simplified — handle known local/common models
    const knownPrices: Record<string, { input: number; output: number }> = {
      'google/gemma-4-26b-a4b-qat': { input: 0.15, output: 0.60 },
      'gemma-4-26b-a4b-qat': { input: 0.15, output: 0.60 },
    };

    // Direct match
    if (knownPrices[modelOrSlug]) return knownPrices[modelOrSlug];

    // Suffix match for provider-prefixed variants
    for (const [key, price] of Object.entries(knownPrices)) {
      if (modelOrSlug.endsWith(key) || key.endsWith(modelOrSlug)) {
        return price;
      }
    }

    return null;
  }
}
