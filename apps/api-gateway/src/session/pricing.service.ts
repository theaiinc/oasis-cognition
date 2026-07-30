/**
 * PricingService — owns the merged pricing table and optionally refreshes it
 * from a remote pricing API on a schedule.
 *
 * Source priority (later overrides earlier):
 *   1. Built-in DEFAULT_PRICING
 *   2. OASIS_MODEL_PRICING_JSON env var (deploy-time override)
 *   3. OASIS_PRICING_API_URL (remote API, fetched on init + every refreshInterval)
 *
 * The remote API should return JSON in a flat format using the same triple key
 * convention: `<router>:<model-provider>:<model>`. Example:
 *   {
 *     "anthropic:anthropic:claude-sonnet-4-7": { "input_per_1m_usd": 3.0, "output_per_1m_usd": 15.0, "updated": "2026-09-01" },
 *     "llmapi:deepseek:deepseek-v4-flash":     { "input_per_1m_usd": 0.20, "output_per_1m_usd": 0.80, "updated": "2026-09-01" }
 *   }
 *
 * The `provider` parameter passed to `pricingFor()` / `estimateUsd()` should
 * use the `<router>:<model-provider>` prefix (e.g. `"anthropic:anthropic"`,
 * `"llmapi:deepseek"`, `"ollama:ollama"`).
 *
 * Set OASIS_PRICING_REFRESH_INTERVAL_MS (default 3600000 = 1h) to control
 * how often the remote API is called.
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import type { ModelPricing, UsdEstimate } from './pricing';

const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // All keys follow the same triple format: "<router>:<model-provider>:<model>"
  // When the router and model-provider are the same entity, they repeat:
  //   "anthropic:anthropic:claude-sonnet-4-7"
  // When the router is a gateway over a third-party model:
  //   "llmapi:deepseek:deepseek-v4-flash"

  // ── Anthropic Claude ──────────────────────────────────────────────
  'anthropic:anthropic:claude-haiku-4-5':   { input_per_1m_usd: 1.0,  output_per_1m_usd: 5.0,   updated: '2026-04-15' },
  'anthropic:anthropic:claude-sonnet-4-5':  { input_per_1m_usd: 3.0,  output_per_1m_usd: 15.0,  updated: '2026-04-15' },
  'anthropic:anthropic:claude-sonnet-4-6':  { input_per_1m_usd: 3.0,  output_per_1m_usd: 15.0,  updated: '2026-04-15' },
  'anthropic:anthropic:claude-sonnet-4-7':  { input_per_1m_usd: 3.0,  output_per_1m_usd: 15.0,  updated: '2026-04-15' },
  'anthropic:anthropic:claude-opus-4-7':    { input_per_1m_usd: 15.0, output_per_1m_usd: 75.0,  updated: '2026-04-15' },

  // ── OpenAI ────────────────────────────────────────────────────────
  'openai:openai:gpt-4o':                { input_per_1m_usd: 2.5,  output_per_1m_usd: 10.0,  updated: '2026-04-15' },
  'openai:openai:gpt-4o-mini':           { input_per_1m_usd: 0.15, output_per_1m_usd: 0.6,   updated: '2026-04-15' },
  'openai:openai:gpt-5':                 { input_per_1m_usd: 10.0, output_per_1m_usd: 30.0,  updated: '2026-04-15' },
  'openai:openai:o1':                    { input_per_1m_usd: 15.0, output_per_1m_usd: 60.0,  updated: '2026-04-15' },
  'openai:openai:o3':                    { input_per_1m_usd: 10.0, output_per_1m_usd: 40.0,  updated: '2026-04-15' },

  // ── DeepSeek first-party ──────────────────────────────────────────
  'deepseek:deepseek:deepseek-chat':       { input_per_1m_usd: 0.27, output_per_1m_usd: 1.10,  updated: '2026-06-04' },
  'deepseek:deepseek:deepseek-reasoner':   { input_per_1m_usd: 0.55, output_per_1m_usd: 2.19,  updated: '2026-06-04' },
  'deepseek:deepseek:deepseek-v3':         { input_per_1m_usd: 0.27, output_per_1m_usd: 1.10,  updated: '2026-06-04' },
  'deepseek:deepseek:deepseek-v3.2':       { input_per_1m_usd: 0.15, output_per_1m_usd: 0.60,  updated: '2026-06-11' },
  'deepseek:deepseek:deepseek-v4-flash':   { input_per_1m_usd: 0.15, output_per_1m_usd: 0.60,  updated: '2026-06-04' },

  // ── Third-party gateway markups over first-party model pricing ─────
  // llmapi is the router/service provider (the billing entity you pay).
  // deepseek is the model provider (who created the model).
  // Triple format: "<router>:<model-provider>:<model>"
  'llmapi:deepseek:deepseek-v4-flash': { input_per_1m_usd: 0.20, output_per_1m_usd: 0.80,  updated: '2026-06-04' },

  // ── Local / free ──────────────────────────────────────────────────
  'ollama:ollama:qwen3':                 { input_per_1m_usd: 0.0,  output_per_1m_usd: 0.0,   updated: '2026-04-15' },
  'ollama:ollama:gemma4':                { input_per_1m_usd: 0.0,  output_per_1m_usd: 0.0,   updated: '2026-04-15' },
  'ollama:ollama:llama3':                { input_per_1m_usd: 0.0,  output_per_1m_usd: 0.0,   updated: '2026-04-15' },
  // LM Studio (local OpenAI-compatible, free inference) — per-variant rows
  'openai:openai:google/gemma-4-26b-a4b-qat': { input_per_1m_usd: 0.0,  output_per_1m_usd: 0.0,   updated: '2026-06-11' },
  'openai:openai:google/gemma-4-12b':         { input_per_1m_usd: 0.0,  output_per_1m_usd: 0.0,   updated: '2026-06-11' },
  'openai:openai:google/gemma-4-12b-qat':     { input_per_1m_usd: 0.0,  output_per_1m_usd: 0.0,   updated: '2026-06-11' },
};

@Injectable()
export class PricingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PricingService.name);

  private table: Record<string, ModelPricing> = {};
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastApiFetch: string | null = null; // ISO timestamp of last API success
  private fetchError: string | null = null;

  /**
   * The HTTP client used to fetch pricing from the remote API.
   * Exposed as protected so tests can inject a mock.
   */
  protected http: AxiosInstance = axios;

  /** URL of a remote pricing API. Empty = skip periodic fetch. */
  private readonly apiUrl = process.env.OASIS_PRICING_API_URL || '';
  /** How often to re-fetch the remote API (default 1 hour). */
  private readonly refreshIntervalMs = parseInt(
    process.env.OASIS_PRICING_REFRESH_INTERVAL_MS || '3600000', 10,
  );
  /** HTTP timeout for the remote API call. */
  private readonly apiTimeoutMs = parseInt(
    process.env.OASIS_PRICING_API_TIMEOUT_MS || '10000', 10,
  );

  onModuleInit() {
    this.mergeTable();
    this.logger.log(`Pricing table initialised (${Object.keys(this.table).length} entries)`);

    if (this.apiUrl) {
      this.logger.log(`Pricing API enabled: ${this.apiUrl} (refresh every ${this.refreshIntervalMs}ms)`);
      // Fetch immediately on startup, then periodically
      this.fetchFromApi().catch(() => { /* logged inside */ });
      this.refreshTimer = setInterval(() => {
        this.fetchFromApi().catch(() => { /* logged inside */ });
      }, this.refreshIntervalMs);
    }
  }

  onModuleDestroy() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // ── Table construction ──────────────────────────────────────────────

  /** (Re)build the table from defaults + env override. Called once at init
   *  and after every API fetch. */
  private mergeTable(apiOverrides?: Record<string, ModelPricing>): void {
    let next: Record<string, ModelPricing> = { ...DEFAULT_PRICING };

    // Layer 2: OASIS_MODEL_PRICING_JSON env var
    const envJson = process.env.OASIS_MODEL_PRICING_JSON;
    if (envJson) {
      try {
        const parsed = JSON.parse(envJson) as Record<string, ModelPricing>;
        next = { ...next, ...parsed };
      } catch {
        this.logger.warn('OASIS_MODEL_PRICING_JSON is invalid JSON — skipping');
      }
    }

    // Layer 3: API-fetched overrides
    if (apiOverrides) {
      next = { ...next, ...apiOverrides };
    }

    this.table = next;
  }

  // ── API fetching ────────────────────────────────────────────────────

  /** Fetch pricing data from the remote API and merge into the table. */
  async fetchFromApi(): Promise<void> {
    if (!this.apiUrl) return;
    try {
      this.logger.log(`Fetching pricing from ${this.apiUrl}`);
      const res = await this.http.get(this.apiUrl, { timeout: this.apiTimeoutMs });
      const data = res.data as Record<string, ModelPricing>;

      if (!data || typeof data !== 'object') {
        throw new Error('API returned non-object response');
      }

      // Validate entries
      const valid: Record<string, ModelPricing> = {};
      let skipped = 0;
      for (const [key, val] of Object.entries(data)) {
        if (
          val &&
          typeof val.input_per_1m_usd === 'number' &&
          typeof val.output_per_1m_usd === 'number' &&
          Number.isFinite(val.input_per_1m_usd) &&
          Number.isFinite(val.output_per_1m_usd)
        ) {
          valid[key] = {
            input_per_1m_usd: val.input_per_1m_usd,
            output_per_1m_usd: val.output_per_1m_usd,
            updated: val.updated || new Date().toISOString().slice(0, 10),
          };
        } else {
          skipped++;
        }
      }

      this.lastApiFetch = new Date().toISOString();
      this.fetchError = null;
      this.mergeTable(valid);
      this.logger.log(
        `Pricing API fetched: ${Object.keys(valid).length} entries merged` +
        (skipped > 0 ? ` (${skipped} skipped for invalid format)` : ''),
      );
    } catch (err: any) {
      const msg = err?.message || String(err);
      this.fetchError = msg;
      this.logger.warn(`Pricing API fetch failed: ${msg} — keeping existing table`);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** Return the full merged pricing table (read-only snapshot). */
  getTable(): Readonly<Record<string, ModelPricing>> {
    return this.table;
  }

  /** Return the table in a JSON-serialisable form with metadata. */
  getTableSnapshot(): {
    entries: Record<string, ModelPricing>;
    entry_count: number;
    last_api_fetch: string | null;
    last_api_error: string | null;
    api_url: string;
    refresh_interval_ms: number;
  } {
    return {
      entries: this.table,
      entry_count: Object.keys(this.table).length,
      last_api_fetch: this.lastApiFetch,
      last_api_error: this.fetchError,
      api_url: this.apiUrl,
      refresh_interval_ms: this.refreshIntervalMs,
    };
  }

  /** Look up pricing for a (provider, model) pair.
   *
   * The `provider` param uses the format `<router>:<model-provider>` (e.g.
   * `"anthropic:anthropic"`, `"llmapi:deepseek"`, `"ollama:ollama"`).
   * The composite lookup key is `<provider>:<model>` = `<router>:<model-provider>:<model>`.
   *
   * Resolution order:
   *   1. `<router>:<model-provider>:<model>` exact match
   *   2. `<router>:<model-provider>:<model>` prefix match (handles date-tagged versions)
   *   3. Bare `<model>` exact match
   *   4. Bare `<model>` longest-prefix match
   *   5. `null` (unknown)
   */
  pricingFor(model: string | undefined | null, provider?: string | null): ModelPricing | null {
    if (!model) return null;
    const { table } = this;

    // Step 1: composite exact
    if (provider) {
      const composite = `${provider}:${model}`;
      if (table[composite]) return table[composite];
    }

    // Step 2: composite prefix
    if (provider) {
      const prefix = `${provider}:`;
      let best: ModelPricing | null = null;
      let bestKeyLen = 0;
      for (const key of Object.keys(table)) {
        if (key.startsWith(prefix) && model.startsWith(key.slice(prefix.length)) && key.length > bestKeyLen) {
          best = table[key];
          bestKeyLen = key.length;
        }
      }
      if (best) return best;
    }

    // Step 3: bare exact
    if (table[model]) return table[model];

    // Step 3.5: when no provider, try suffix match against composite keys
    // (e.g. runner reports "google/gemma-4-26b-a4b-qat" and table has
    //  "openai:openai:google/gemma-4-26b-a4b-qat")
    if (!provider) {
      const suffix = `:${model}`;
      for (const key of Object.keys(table)) {
        if (key.endsWith(suffix)) {
          return table[key];
        }
      }
    }

    // Step 4: bare prefix
    let best: ModelPricing | null = null;
    let bestKeyLen = 0;
    for (const key of Object.keys(table)) {
      if (model.startsWith(key) && key.length > bestKeyLen) {
        best = table[key];
        bestKeyLen = key.length;
      }
    }
    return best;
  }

  /** Estimate USD cost for the given token counts. */
  estimateUsd(
    input_tokens: number,
    output_tokens: number,
    model: string | undefined | null,
    provider?: string | null,
  ): UsdEstimate {
    const p = this.pricingFor(model, provider);
    if (!p) return { usd: 0, known: false, updated_at: null };
    const usd =
      (input_tokens / 1_000_000) * p.input_per_1m_usd +
      (output_tokens / 1_000_000) * p.output_per_1m_usd;
    return { usd, known: true, updated_at: p.updated };
  }
}
