import type { AgentAdapter, AgentCommand, ExternalAgentSession, NormalizedEvent } from '../types';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

function isoNow(): string {
  return new Date().toISOString();
}

function baseArgs(
  session: ExternalAgentSession,
  mcpConfigPath?: string,
  extraArgs: string[] = [],
): string[] {
  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', session.permission_mode,
    '--session-id', session.session_id,
    '--add-dir', session.worktree_path,
  ];
  if (session.model) {
    args.push('--model', session.model);
  }
  if (session.system_prompt_preamble) {
    args.push('--append-system-prompt', session.system_prompt_preamble);
  }
  if (session.mcp_enabled && mcpConfigPath) {
    args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
  }
  for (const arg of extraArgs) args.push(arg);
  return args;
}

export const claudeCodeAdapter: AgentAdapter = {
  type: 'claude-code',

  buildInitialCommand(session, mcpConfigPath, extraArgs): AgentCommand {
    return {
      cmd: CLAUDE_BIN,
      args: ['-p', session.goal, ...baseArgs(session, mcpConfigPath, extraArgs)],
    };
  },

  buildFollowUpCommand(session, message, mcpConfigPath, extraArgs): AgentCommand {
    const resumeId = session.child_session_id || session.session_id;
    return {
      cmd: CLAUDE_BIN,
      args: ['--resume', resumeId, '-p', message, ...baseArgs(session, mcpConfigPath, extraArgs)],
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

    const t = evt?.type;

    if (t === 'system') {
      return {
        kind: 'system',
        at: isoNow(),
        text: evt.subtype || 'system',
        meta: evt,
      };
    }

    if (t === 'result') {
      return {
        kind: 'result',
        at: isoNow(),
        text: evt.result || evt.subtype,
        meta: evt,
      };
    }

    if (t === 'assistant' || t === 'user') {
      const message = evt.message;
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const part of content) {
        if (part?.type === 'text') {
          return { kind: 'assistant_text', at: isoNow(), text: part.text || '', meta: { role: message.role } };
        }
        if (part?.type === 'tool_use') {
          return {
            kind: 'tool_use',
            at: isoNow(),
            tool: part.name,
            input: part.input,
            meta: { id: part.id, server: part.server_name },
          };
        }
        if (part?.type === 'tool_result') {
          return {
            kind: 'tool_result',
            at: isoNow(),
            tool: part.tool_use_id,
            output: part.content,
            meta: { is_error: !!part.is_error },
          };
        }
      }
      return { kind: 'system', at: isoNow(), text: `${t}:empty`, meta: evt };
    }

    return { kind: 'system', at: isoNow(), text: String(t ?? 'unknown'), meta: evt };
  },

  summarise(events): Partial<Pick<ExternalAgentSession, 'final_message' | 'cost_usd' | 'tokens' | 'child_session_id'>> {
    const out: Partial<Pick<ExternalAgentSession, 'final_message' | 'cost_usd' | 'tokens' | 'child_session_id'>> = {};
    for (const e of events) {
      if (e.kind === 'system' && e.meta?.session_id) {
        out.child_session_id = e.meta.session_id;
        break;
      }
    }

    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind === 'assistant_text' && e.text) {
        out.final_message = e.text;
        break;
      }
    }

    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind === 'result' && e.meta) {
        const m = e.meta;
        if (typeof m.total_cost_usd === 'number') out.cost_usd = m.total_cost_usd;
        const usage = m.usage || m.message?.usage;
        if (usage) {
          out.tokens = {
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
          };
        }
        break;
      }
    }
    return out;
  },
};
