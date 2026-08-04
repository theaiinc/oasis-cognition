import type {
  AgentAdapter, AgentCommand, ExternalAgentSession, NormalizedEvent,
} from '../types';

const CURSOR_BIN = process.env.CURSOR_BIN || 'cursor-agent';

function isoNow(): string { return new Date().toISOString(); }

function permissionFlags(session: ExternalAgentSession): string[] {
  switch (session.permission_mode) {
    case 'plan':
      return ['--mode', 'plan'];
    case 'acceptEdits':
      return ['-f'];
    case 'bypassPermissions':
      return ['-f', '--sandbox', 'disabled'];
    case 'default':
    default:
      return [];
  }
}

function baseArgs(session: ExternalAgentSession, extraArgs: string[] = []): string[] {
  const args = [
    '--output-format', 'stream-json',
    '--workspace', session.worktree_path,
    ...permissionFlags(session),
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

export const cursorCliAdapter: AgentAdapter = {
  type: 'cursor-cli',

  buildInitialCommand(session, _mcpConfigPath, extraArgs): AgentCommand {
    return {
      cmd: CURSOR_BIN,
      args: ['-p', withPreamble(session, session.goal), ...baseArgs(session, extraArgs)],
    };
  },

  buildFollowUpCommand(session, message, _mcpConfigPath, extraArgs): AgentCommand {
    const prompt = withPreamble(session, message);
    const args = session.child_session_id
      ? ['--resume', session.child_session_id, '-p', prompt, ...baseArgs(session, extraArgs)]
      : ['--continue', '-p', prompt, ...baseArgs(session, extraArgs)];
    return { cmd: CURSOR_BIN, args };
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

    if (t === 'system' || t === 'init') {
      return {
        kind: 'system',
        at: isoNow(),
        text: evt.subtype || t,
        meta: evt,
      };
    }

    if (t === 'thinking') {
      return { kind: 'system', at: isoNow(), text: 'thinking', meta: evt };
    }

    if (t === 'user') {
      return { kind: 'system', at: isoNow(), text: 'user', meta: evt };
    }

    if (t === 'assistant' || t === 'assistant_message' || t === 'text' || typeof evt?.text === 'string') {
      let text = typeof evt.text === 'string' ? evt.text : undefined;
      if (!text && Array.isArray(evt.message?.content)) {
        const p = evt.message.content.find((c: any) => c?.type === 'text');
        text = p?.text;
      }
      if (!text && typeof evt.delta === 'string') text = evt.delta;
      return { kind: 'assistant_text', at: isoNow(), text: text || '', meta: evt };
    }

    if (t === 'tool_call') {
      const tc = evt.tool_call || {};
      const key = Object.keys(tc)[0] || '';
      const toolName = key.replace(/ToolCall$/, '');
      const inner = tc[key] || {};
      if (evt.subtype === 'completed') {
        return {
          kind: 'tool_result',
          at: isoNow(),
          tool: toolName || evt.call_id,
          output: inner.result,
          meta: { is_error: inner.result?.error != null, call_id: evt.call_id },
        };
      }
      return {
        kind: 'tool_use',
        at: isoNow(),
        tool: toolName || 'tool',
        input: inner.args,
        meta: { call_id: evt.call_id, subtype: evt.subtype },
      };
    }

    if (t === 'tool_use') {
      return {
        kind: 'tool_use',
        at: isoNow(),
        tool: evt.name,
        input: evt.input,
        meta: evt,
      };
    }
    if (t === 'tool_result' || t === 'tool_response') {
      return {
        kind: 'tool_result',
        at: isoNow(),
        tool: evt.name || evt.tool_use_id,
        output: evt.result ?? evt.output ?? evt.content,
        meta: { is_error: !!evt.is_error },
      };
    }

    if (t === 'result' || t === 'end' || t === 'done' || evt?.usage) {
      return {
        kind: 'result',
        at: isoNow(),
        text: evt.result || evt.message || t || 'result',
        meta: evt,
      };
    }

    if (t === 'error' || evt?.error) {
      return {
        kind: 'error',
        at: isoNow(),
        text: evt.error || evt.message || 'error',
        meta: evt,
      };
    }

    return { kind: 'system', at: isoNow(), text: String(t ?? 'event'), meta: evt };
  },

  summarise(events) {
    const out: Partial<Pick<ExternalAgentSession, 'final_message' | 'cost_usd' | 'tokens' | 'child_session_id'>> = {};

    for (const e of events) {
      const sid = e.meta?.chat_id || e.meta?.session_id || e.meta?.chatId;
      if (typeof sid === 'string' && sid.length > 0) { out.child_session_id = sid; break; }
    }

    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind === 'assistant_text' && e.text) { out.final_message = e.text; break; }
    }
    if (!out.final_message) {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.kind === 'result' && typeof e.meta?.result === 'string') {
          out.final_message = e.meta.result;
          break;
        }
      }
    }

    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind === 'result' && e.meta) {
        const m = e.meta;
        const cost = m.total_cost_usd ?? m.cost_usd ?? m.cost;
        if (typeof cost === 'number') out.cost_usd = cost;
        const usage = m.usage || m.message?.usage || m.tokens;
        if (usage && (usage.input_tokens || usage.input || usage.prompt_tokens ||
                      usage.output_tokens || usage.output || usage.completion_tokens)) {
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
