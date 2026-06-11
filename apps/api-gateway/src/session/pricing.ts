/**
 * Per-model token pricing types and convenience wrappers.
 *
 * **New code should use PricingService** (`pricing.service.ts`) instead of
 * calling these module-level functions directly. PricingService merges
 * defaults + env override + optional remote API and refreshes on a schedule.
 *
 * These module-level functions are kept for backward compatibility with the
 * static table format consumed by `PricingService` as its fallback layer.
 */

export interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  input_per_1m_usd: number;
  /** USD per 1,000,000 output tokens. */
  output_per_1m_usd: number;
  /** When this row was last verified against the provider's published rates. ISO date (YYYY-MM-DD). */
  updated: string;
}

export interface UsdEstimate {
  /** Estimated cost in USD. 0 when pricing is unknown — caller should check `known` to decide whether to display "$?". */
  usd: number;
  /** False when no pricing row matched the (provider, model) — UI should fall back to the token meter only. */
  known: boolean;
  /** When this row's rates were last verified, for the "rates may be stale" hover tooltip. */
  updated_at: string | null;
}
