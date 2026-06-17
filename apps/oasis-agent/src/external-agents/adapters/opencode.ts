/**
 * OpenCode adapter — external coding agent adapter for OpenCode v1.17+.
 *
 * OpenCode is an open-source AI coding agent: https://opencode.ai
 * CLI: `opencode run "prompt"` with support for `--format json`,
 * `--cwd`, `--model`, and `--quiet` flags.
 *
 * Env:
 *   OPENCODE_BIN — path to the opencode binary (default: opencode)
 */
import type { AgentAdapter, AgentCommand, ExternalAgentSession, NormalizedEvent } from '../types';

const OPENCODE_BIN = process.env.OPENCODE_BIN || 'opencode';

function isoNow(): string {
  return new Date().toISOString();
}

function baseArgs(
  session: ExternalAgentSession,
  extraArgs: string[] = [],
): string[] {
  const args: string[] = [
    'run',
    '--format', 'json',
    '--quiet',
    '--cwd', session.worktree_path,
  ];
  if (session.model) {
    args.push('--model', session.model);
  }
  for (const arg of extraArgs) args.push(arg);
  return args;
}

function withPreamble(session: ExternalAgentSession, prompt: string): string {
  if (!session.system_prompt_preamble) return prompt;
  return `[Role context]\n${session.system_prompt_preamble}\n\n---\n\n${prompt}`;
}

export const openCodeAdapter: AgentAdapter = {
  type: 'opencode',

  buildInitialCommand(session, _mcpConfigPath, extraArgs): AgentCommand {
    return {
      cmd: OPENCODE_BIN,
      args: [...baseArgs(session, extraArgs), withPreamble(session, session.goal)],
    };
  },

  buildFollowUpCommand(session, message, _mcpConfigPath, extraArgs): AgentCommand {
    return {
      cmd: OPENCODE_BIN,
      args: [...baseArgs(session, extraArgs), withPreamble(session, message)],
    };
  },

  parseStreamEvent(line: string): NormalizedEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let evt: any;
    try { evt = JSON.parse(trimmed); } catch { return null; }

    if (evt?.kind === 'stderr') {
      return { kind: 'stderr', at: isoNow(), text: evt.text };
    }

    const level = evt?.level || '';
    const msg = evt?.msg || evt?.message || '';

    if (level === 'error' || evt?.error) {
      return {
        kind: 'error',
        at: isoNow(),
        text: evt.error || msg || 'error',
        meta: evt,
      };
    }

    // OpenCode v1.17 JSON output events:
    // - { "type": "result", "data": { "output": "..." } }
    // - { "type": "error", "error": "..." }
    // - { "type": "text", "text": "...", ... }
    // - { "type": "tool_use", "name": "...", "input": {...}, ... }
    // - { "type": "tool_result", "name": "...", "output": "...", ... }
    // - { "type": "reasoning", "content": "...", ... }

    if (evt?.type === 'result' || evt?.type === 'final') {
      const output = evt.data?.output || evt.output || evt.text || '';
      return {
        kind: 'result',
        at: isoNow(),
        text: output || 'completed',
        meta: evt,
      };
    }

    if (evt?.type === 'reasoning' || evt?.type === 'thinking' || level === 'thinking') {
      return {
        kind: 'system',
        at: isoNow(),
        text: evt.content || evt.text || msg || 'thinking',
        meta: evt,
      };
    }

    if (evt?.type === 'tool_use' || evt?.type === 'tool_call') {
      return {
        kind: 'tool_use',
        at: isoNow(),
        tool: evt.name || evt.tool || 'tool',
        input: evt.input || evt.arguments,
        meta: evt,
      };
    }

    if (evt?.type === 'tool_result' || evt?.type === 'observation') {
      return {
        kind: 'tool_result',
        at: isoNow(),
        tool: evt.name || evt.tool_use_id || 'tool',
        output: evt.result ?? evt.output ?? evt.content,
        meta: { is_error: !!evt.is_error },
      };
    }

    // Assistant text output (OpenCode v1.17 uses "text" events for streaming)
    if (evt?.type === 'assistant' || evt?.type === 'text' || typeof evt?.text === 'string') {
      return {
        kind: 'assistant_text',
        at: isoNow(),
        text: evt.text || msg || '',
        meta: evt,
      };
    }

    if (msg) {
      return {
        kind: 'assistant_text',
        at: isoNow(),
        text: msg,
        meta: evt,
      };
    }

    return { kind: 'system', at: isoNow(), text: String(evt?.type ?? 'event'), meta: evt };
  },

  summarise(events): Partial<Pick<ExternalAgentSession, 'final_message' | 'cost_usd' | 'tokens' | 'child_session_id'>> {
    const out: Partial<Pick<ExternalAgentSession, 'final_message' | 'cost_usd' | 'tokens' | 'child_session_id'>> = {};

    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind === 'result' && e.text) {
        out.final_message = e.text;
        break;
      }
      if (e.kind === 'assistant_text' && e.text) {
        out.final_message = e.text;
        break;
      }
    }

    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind === 'result' && e.meta) {
        const m = e.meta;
        const cost = m.total_cost_usd ?? m.cost_usd ?? m.cost;
        if (typeof cost === 'number') out.cost_usd = cost;
        const usage = m.data?.usage || m.usage || m.tokens;
        if (usage) {
          out.tokens = {
            input: usage.input_tokens ?? usage.input ?? usage.prompt_tokens ?? 0,
            output: usage.output_tokens ?? usage.output ?? usage.completion_tokens ?? 0,
          };
        }
        break;
      }
    }

    return out;
  },
};
