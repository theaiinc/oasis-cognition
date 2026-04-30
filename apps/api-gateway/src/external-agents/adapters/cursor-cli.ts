/**
 * Cursor CLI adapter (`cursor-agent`).
 *
 * Invocation shape:
 *
 *   cursor-agent -p "<goal>" \
 *     --output-format stream-json \
 *     [--mode plan] [--force] [--sandbox disabled] \
 *     --workspace <worktree>
 *
 * Follow-up:
 *
 *   cursor-agent --resume <chat_id> -p "<msg>" --output-format stream-json --workspace <wt> ...
 *
 * Notes vs Claude Code:
 *   • Cursor has no `--mcp-config <path>` equivalent; MCP servers are read from
 *     `~/.cursor/mcp.json` or `.cursor/mcp.json` in cwd. For v1 we ignore
 *     `mcp_enabled` for cursor-cli (users can register the Oasis server once
 *     via `cursor-agent mcp enable oasis`). Loopback is a future enhancement.
 *   • The chat id is assigned by cursor-agent itself; we extract it from the
 *     first `system`/`init` event and store it in `child_session_id` for
 *     --resume on follow-ups.
 *   • Prereq: user must have run `cursor-agent login` or set `CURSOR_API_KEY`.
 *     If not authenticated, the child exits non-zero and the session flips to
 *     `failed` with the auth error surfaced in the transcript.
 */

import type {
  AgentAdapter, AgentCommand, ExternalAgentSession, NormalizedEvent,
} from '../external-agents.types';

const CURSOR_BIN = process.env.CURSOR_BIN || 'cursor-agent';

function isoNow(): string { return new Date().toISOString(); }

/** Map our cross-agent PermissionMode onto cursor-agent flags. */
function permissionFlags(session: ExternalAgentSession): string[] {
  switch (session.permission_mode) {
    case 'plan':
      return ['--mode', 'plan'];
    case 'acceptEdits':
      // -f = auto-approve commands unless explicitly denied. Worktree
      // containment is our safety net.
      return ['-f'];
    case 'bypassPermissions':
      return ['-f', '--sandbox', 'disabled'];
    case 'default':
    default:
      // No flag — cursor may hang in -p mode waiting for approvals. We log a
      // warning at the service layer if users pick this for cursor.
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

/** Cursor CLI has no system-prompt flag, so we inject the preamble by
 *  prepending it to the user-visible prompt. The `[Role context]` header
 *  keeps the boundary legible for the model. */
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
    // Use the chat id cursor assigned on first run. Fallback to --continue if
    // we never captured one.
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

    // dev-agent-wrapped stderr lines
    if (evt?.kind === 'stderr') {
      return { kind: 'stderr', at: isoNow(), text: evt.text };
    }

    const t = evt?.type;

    // Cursor's exact event shape isn't officially documented. Be permissive:
    // recognise common field names and map, otherwise surface as a system
    // event with full payload in meta so the UI can still show something.

    // Init / session-id hint — only when type is explicitly system/init.
    // (cursor includes session_id on every event, so we must not short-circuit here.)
    if (t === 'system' || t === 'init') {
      return {
        kind: 'system',
        at: isoNow(),
        text: evt.subtype || t,
        meta: evt,
      };
    }

    // Thinking / reasoning blocks — surface as system for now
    if (t === 'thinking') {
      return { kind: 'system', at: isoNow(), text: 'thinking', meta: evt };
    }

    // User echo (cursor re-emits the user message) — surface as system
    if (t === 'user') {
      return { kind: 'system', at: isoNow(), text: 'user', meta: evt };
    }

    // Assistant text — a few shapes we've seen or expect
    if (t === 'assistant' || t === 'assistant_message' || t === 'text' || typeof evt?.text === 'string') {
      // Prefer explicit `text` field; fall back to message.content[0].text
      let text = typeof evt.text === 'string' ? evt.text : undefined;
      if (!text && Array.isArray(evt.message?.content)) {
        const p = evt.message.content.find((c: any) => c?.type === 'text');
        text = p?.text;
      }
      if (!text && typeof evt.delta === 'string') text = evt.delta;
      return { kind: 'assistant_text', at: isoNow(), text: text || '', meta: evt };
    }

    // Cursor tool_call — nested shape:
    //   { type: "tool_call", subtype: "started"|"completed",
    //     tool_call: { <name>ToolCall: { args, result? } } }
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

    // Claude-style tool use / tool result (fallback for other cursor shapes)
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

    // Terminal result / usage
    if (t === 'result' || t === 'end' || t === 'done' || evt?.usage) {
      return {
        kind: 'result',
        at: isoNow(),
        text: evt.result || evt.message || t || 'result',
        meta: evt,
      };
    }

    // Errors
    if (t === 'error' || evt?.error) {
      return {
        kind: 'error',
        at: isoNow(),
        text: evt.error || evt.message || 'error',
        meta: evt,
      };
    }

    // Unknown — keep the raw payload visible in meta
    return { kind: 'system', at: isoNow(), text: String(t ?? 'event'), meta: evt };
  },

  summarise(events) {
    const out: Partial<Pick<ExternalAgentSession, 'final_message' | 'cost_usd' | 'tokens' | 'child_session_id'>> = {};

    // Pull chat_id / session_id from any event that carries it (usually the init system event).
    for (const e of events) {
      const sid = e.meta?.chat_id || e.meta?.session_id || e.meta?.chatId;
      if (typeof sid === 'string' && sid.length > 0) { out.child_session_id = sid; break; }
    }

    // Prefer the last assistant_text; otherwise fall back to result.result
    // (cursor's `result` event carries the concatenated final response).
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

    // Cost + tokens from the last result event, if cursor reports them
    // (cursor may omit these — sessions still work, we just don't show cost).
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
