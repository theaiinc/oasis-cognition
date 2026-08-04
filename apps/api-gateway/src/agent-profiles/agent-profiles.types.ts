/**
 * Agent profile — a reusable, named configuration for an agent. Profiles
 * decouple "which agent" (claude-code / cursor-cli / internal) from "how it
 * runs" (model, permission mode, system prompt, extra args). Agent Runner
 * and project roles both reference profiles by id.
 */

export type ProfileAgentType = 'internal' | 'claude-code' | 'cursor-cli' | 'opencode';
export type PermissionMode = 'plan' | 'acceptEdits' | 'bypassPermissions' | 'default';

export interface AgentProfileConfig {
  /** For internal profiles: the LLM model. For external CLIs: the value
   *  passed as `--model` on the command line. */
  model?: string;
  /** For internal profiles only — which LLM provider to use.
   *  'openai' → any OpenAI-compatible API (OpenAI, DeepSeek, LLM API, vLLM, etc.) */
  provider?: 'ollama' | 'openai' | 'anthropic';
  /** Internal routing precedence: Leyline by default, or explicit direct pin. */
  routing_provider?: 'leyline' | 'direct';
  /** Optional internal-provider transport and budgeting controls. */
  base_url?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;
  max_tokens?: number;
  leyline_base_url?: string;
  leyline_provider?: string;
  leyline_model?: string;
  leyline_max_budget_usd?: number;
  leyline_daily_budget_usd?: number;
  /** External-only. Default `acceptEdits`. */
  permission_mode?: PermissionMode;
  /** External-only. Whether the Oasis MCP server should be auto-wired.
   *  Defaults: true for claude-code, false for cursor-cli and opencode (no per-session
   *  MCP config flag). */
  mcp_enabled?: boolean;
  /** Prepended to every spawn's goal/prompt. Applied after the role
   *  preamble if both are present. */
  system_prompt_preamble?: string;
  /** Optional passthrough CLI args for external adapters. */
  extra_args?: string[];
  /** Billing class for cost estimation and approval gating.
   *  Inferred from provider/model if not set. */
  billing_class?: 'free_local' | 'paid_api' | 'subscription_external' | 'uncertain';
  /** Rough resource footprint for capacity planning. */
  resource_class?: 'light' | 'standard' | 'gpu';
  /** Override the model's context window (tokens). Defaults to the model variant's context_length.
   *  Research agents typically need huge windows; coding agents can use moderate; chat agents can use small. */
  context_window?: number;
  /** Fraction of context_window reserved for output (0.0–1.0). Default 0.4.
   *  Higher → more room for thinking/completion tokens, less for input context. */
  context_output_reserve?: number;
}

export interface AgentProfile {
  profile_id: string;
  name: string;
  description?: string;
  agent_type: ProfileAgentType;
  config: AgentProfileConfig;
  created_at: string;
  updated_at: string;
}

export interface CreateAgentProfileDto {
  name: string;
  description?: string;
  agent_type: ProfileAgentType;
  config?: AgentProfileConfig;
}

export interface UpdateAgentProfileDto extends Partial<CreateAgentProfileDto> {}
