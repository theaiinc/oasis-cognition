/**
 * Model variant definitions — the canonical registry of every known model
 * variant and its properties.
 *
 * This replaces ad‑hoc model string matching with a structured catalog so
 * billing_class, resource_class, capabilities, context length, and other
 * attributes are inferred correctly from the (provider, model) pair.
 *
 * Naming conventions:
 *   - provider: `"openai"` for LM Studio / any OpenAI‑compatible endpoint,
 *               `"ollama"` for Ollama, `"anthropic"` for Anthropic, etc.
 *   - model:    the exact string the LLM API expects (e.g.
 *               `"google/gemma-4-26b-a4b-qat"`)
 *
 * Look‑up order (first match wins):
 *   1. Exact (provider, model)
 *   2. Prefix (provider, model) — e.g. `"google/gemma-4"` matches any gemma-4
 *   3. Bare model exact
 *   4. Bare model prefix
 */

// ── Types (moved from coordinator types to avoid circular dep) ──────────

export type BillingClass =
  | 'free_local'
  | 'paid_api'
  | 'subscription_external'
  | 'uncertain';

export type ResourceClass = 'light' | 'standard' | 'gpu';

// ── Model variant definitions ─────────────────────────────────────────────

export interface ModelVariant {
  /** The exact model string the LLM API expects. */
  id: string;
  /** Human‑readable display name. */
  name: string;
  /** Model family, e.g. "gemma-4", "qwen3", "deepseek-v4". */
  family: string;
  /** Which provider family this model belongs to. */
  provider: 'openai' | 'ollama' | 'anthropic' | 'deepseek';
  /**
   * Provider sub‑type for pricing/display. For LM Studio models this
   * is `"lmstudio"`, for DeepSeek via llmapi it would be `"deepseek"`, etc.
   */
  source: string;

  // ── Hardware / resource characteristics ─────────────────────────────
  parameter_size_b: number;       // total parameters in billions
  active_params_b?: number;       // for MoE models, active params in billions
  quantization: string;           // e.g. "Q4_K_M", "QAT", "fp16"
  context_length: number;         // max context window in tokens

  // ── Capabilities ────────────────────────────────────────────────────
  capabilities: {
    tools: boolean;
    thinking: boolean;
    vision: boolean;
    code: boolean;                // coding‑optimised
    embedding: boolean;
  };

  // ── Classification ──────────────────────────────────────────────────
  billing_class: BillingClass;
  resource_class: ResourceClass;
}

// ── Registry ───────────────────────────────────────────────────────────

const registry: ModelVariant[] = [
  // ── LM Studio / local ────────────────────────────────────────────────
  // google/gemma-4-26b-a4b-qat — 26B total, 4B active, QAT, tools+vision+thinking
  {
    id: 'google/gemma-4-26b-a4b-qat',
    name: 'Gemma 4 26B (4B active) QAT',
    family: 'gemma-4',
    provider: 'openai',
    source: 'lmstudio',

    parameter_size_b: 26,
    active_params_b: 4,
    quantization: 'QAT',
    context_length: 262_144,

    capabilities: {
      tools: true,
      thinking: true,
      vision: true,
      code: true,
      embedding: false,
    },

    billing_class: 'free_local',
    resource_class: 'gpu',
  },

  // google/gemma-4-12b — 12B, Q4_K_M, tools+vision+thinking
  {
    id: 'google/gemma-4-12b',
    name: 'Gemma 4 12B Q4_K_M',
    family: 'gemma-4',
    provider: 'openai',
    source: 'lmstudio',

    parameter_size_b: 12,
    quantization: 'Q4_K_M',
    context_length: 262_144,

    capabilities: {
      tools: true,
      thinking: true,
      vision: true,
      code: true,
      embedding: false,
    },

    billing_class: 'free_local',
    resource_class: 'standard',
  },

  // google/gemma-4-12b-qat — 12B, QAT
  {
    id: 'google/gemma-4-12b-qat',
    name: 'Gemma 4 12B QAT',
    family: 'gemma-4',
    provider: 'openai',
    source: 'lmstudio',

    parameter_size_b: 12,
    quantization: 'QAT',
    context_length: 262_144,

    capabilities: {
      tools: true,
      thinking: true,
      vision: true,
      code: true,
      embedding: false,
    },

    billing_class: 'free_local',
    resource_class: 'standard',
  },

  // gemma-4-12b-coder-fable5-composer2.5-v1 — fine-tuned 12B coder
  {
    id: 'gemma-4-12b-coder-fable5-composer2.5-v1',
    name: 'Gemma 4 12B Coder Fable5 Composer2.5 v1',
    family: 'gemma-4',
    provider: 'openai',
    source: 'lmstudio',

    parameter_size_b: 12,
    quantization: 'unknown',
    context_length: 262_144,

    capabilities: {
      tools: true,
      thinking: true,
      vision: false,
      code: true,
      embedding: false,
    },

    billing_class: 'free_local',
    resource_class: 'standard',
  },

  // google/gemma-4-e2b — 2B, fast for testing
  {
    id: 'google/gemma-4-e2b',
    name: 'Gemma 4 e2B',
    family: 'gemma-4',
    provider: 'openai',
    source: 'lmstudio',

    parameter_size_b: 2,
    quantization: 'fp16',
    context_length: 262_144,

    capabilities: {
      tools: true,
      thinking: true,
      vision: false,
      code: false,
      embedding: false,
    },

    billing_class: 'free_local',
    resource_class: 'standard',
  },

  // ── Ollama / local (legacy) ──────────────────────────────────────────
  {
    id: 'qwen3:8b',
    name: 'Qwen 3 8B Q4_K_M',
    family: 'qwen3',
    provider: 'ollama',
    source: 'ollama',

    parameter_size_b: 8,
    quantization: 'Q4_K_M',
    context_length: 40_960,

    capabilities: {
      tools: true,
      thinking: true,
      vision: false,
      code: true,
      embedding: false,
    },

    billing_class: 'free_local',
    resource_class: 'standard',
  },

  // ── DeepSeek (first‑party) ───────────────────────────────────────────
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    family: 'deepseek-v4',
    provider: 'deepseek',
    source: 'deepseek',

    parameter_size_b: 0,          // proprietary
    quantization: 'unknown',
    context_length: 128_000,

    capabilities: {
      tools: true,
      thinking: true,
      vision: false,
      code: true,
      embedding: false,
    },

    billing_class: 'paid_api',
    resource_class: 'standard',
  },

  // deepseek-v3.2 — used as fallback by computer-use controller
  {
    id: 'deepseek-v3.2',
    name: 'DeepSeek V3.2',
    family: 'deepseek-v3',
    provider: 'deepseek',
    source: 'deepseek',

    parameter_size_b: 0,          // proprietary
    quantization: 'unknown',
    context_length: 128_000,

    capabilities: {
      tools: true,
      thinking: false,
      vision: false,
      code: true,
      embedding: false,
    },

    billing_class: 'paid_api',
    resource_class: 'standard',
  },

  // ── LM Studio / local: vision & embedding ──────────────────────────
  {
    id: 'text-embedding-nomic-embed-text-v1.5',
    name: 'Nomic Embed Text v1.5',
    family: 'nomic-embed',
    provider: 'openai',
    source: 'lmstudio',

    parameter_size_b: 0.137,      // 137M
    quantization: 'fp16',
    context_length: 8_192,

    capabilities: {
      tools: false,
      thinking: false,
      vision: false,
      code: false,
      embedding: true,
    },

    billing_class: 'free_local',
    resource_class: 'light',
  },

  // arch-router-1.5b.gguf — purpose-built routing model, tiny & fast
  {
    id: 'arch-router-1.5b.gguf',
    name: 'Arch Router 1.5B',
    family: 'qwen2',
    provider: 'openai',
    source: 'lmstudio',

    parameter_size_b: 1.5,
    quantization: 'Q4_K_M',
    context_length: 32_768,

    capabilities: {
      tools: false,
      thinking: false,
      vision: false,
      code: false,
      embedding: false,
    },

    billing_class: 'free_local',
    resource_class: 'light',
  },

  // qwen3-4b-z-image-engineer-v4 — loaded in LM Studio, vision-capable
  {
    id: 'qwen3-4b-z-image-engineer-v4',
    name: 'Qwen 3 4B Z-Image Engineer v4',
    family: 'qwen3',
    provider: 'openai',
    source: 'lmstudio',

    parameter_size_b: 4,
    quantization: 'unknown',
    context_length: 32_768,

    capabilities: {
      tools: false,
      thinking: false,
      vision: true,
      code: false,
      embedding: false,
    },

    billing_class: 'free_local',
    resource_class: 'standard',
  },
];

// ── Look‑up helpers ────────────────────────────────────────────────────

/**
 * Find the best‑matching ModelVariant for a (provider, model) pair.
 *
 * Resolution order:
 *   1. Exact match on (provider, id)
 *   2. Prefix match — provider matches, model starts with entry's id
 *   3. Exact match on bare id (ignoring provider)
 *   4. Prefix match on bare id
 *   5. `null` (unknown)
 */
export function lookupVariant(provider: string | null | undefined, model: string | null | undefined): ModelVariant | null {
  if (!model) return null;

  const normProvider = (provider || '').toLowerCase();
  const normModel = model.trim();

  // 1. Exact (provider, id)
  for (const v of registry) {
    if (v.provider === normProvider && v.id === normModel) return v;
  }

  // 2. Prefix — provider matches, model starts with entry's id
  for (const v of registry) {
    if (v.provider === normProvider && normModel.startsWith(v.id)) return v;
  }

  // 3. Bare exact
  for (const v of registry) {
    if (v.id === normModel) return v;
  }

  // 4. Bare prefix
  let best: ModelVariant | null = null;
  let bestLen = 0;
  for (const v of registry) {
    if (normModel.startsWith(v.id) && v.id.length > bestLen) {
      best = v;
      bestLen = v.id.length;
    }
  }
  return best;
}

/** Convenience: infer billing_class from (provider, model). Returns 'uncertain' if unknown. */
export function inferBillingClass(provider: string | null | undefined, model: string | null | undefined): BillingClass {
  return lookupVariant(provider, model)?.billing_class ?? 'uncertain';
}

/** Convenience: infer resource_class from (provider, model). Returns 'standard' if unknown. */
export function inferResourceClass(provider: string | null | undefined, model: string | null | undefined): ResourceClass {
  return lookupVariant(provider, model)?.resource_class ?? 'standard';
}

/** Get the context length for a (provider, model) pair. Returns 128_000 as a safe default. */
export function getContextLength(provider: string | null | undefined, model: string | null | undefined): number {
  return lookupVariant(provider, model)?.context_length ?? 128_000;
}

/** List all known variants (for admin / debug endpoints). */
export function listVariants(): ModelVariant[] {
  return [...registry];
}

/**
 * Validate that a (provider, model) pair is consistent.
 * Returns `null` if valid, or an error message string if the pair doesn't
 * match any known variant's provider assignment.
 *
 * Examples:
 *   validateModelProvider('openai', 'google/gemma-4-26b-a4b-qat') → null    (OK)
 *   validateModelProvider('ollama', 'google/gemma-4-26b-a4b-qat') → string (bad)
 */
export function validateModelProvider(
  provider: string | null | undefined,
  model: string | null | undefined,
): string | null {
  if (!model) return null;           // no model = nothing to validate
  const v = lookupVariant(null, model);
  if (!v) return null;               // unknown model — can't validate
  if (!provider) return null;         // no provider — can't validate
  const normProvider = provider.toLowerCase();
  if (v.provider !== normProvider && v.provider !== normProvider.replace(/:.+$/, '')) {
    return `Model "${model}" expects provider "${v.provider}" but got "${provider}"`;
  }
  return null;
}
