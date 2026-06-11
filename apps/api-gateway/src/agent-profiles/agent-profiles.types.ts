/**
 * Agent profile — a reusable, named configuration for an agent. Profiles
 * decouple "which agent" (claude-code / cursor-cli / internal) from "how it
 * runs" (model, permission mode, system prompt, extra args). Agent Runner
 * and project roles both reference profiles by id.
 */

export type ProfileAgentType = 'internal' | 'claude-code' | 'cursor-cli';
export type PermissionMode = 'plan' | 'acceptEdits' | 'bypassPermissions' | 'default';

export interface AgentProfileConfig {
  /** For internal profiles: the LLM model. For external CLIs: the value
   *  passed as `--model` on the command line. */
  model?: string;
  /** For internal profiles only — which LLM provider to use.
   *  'openai' → any OpenAI-compatible API (OpenAI, DeepSeek, LLM API, vLLM, etc.) */
  provider?: 'ollama' | 'openai' | 'anthropic';
  /** External-only. Default `acceptEdits`. */
  permission_mode?: PermissionMode;
  /** External-only. Whether the Oasis MCP server should be auto-wired.
   *  Defaults: true for claude-code, false for cursor-cli (no per-session
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
