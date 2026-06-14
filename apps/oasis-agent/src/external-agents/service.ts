import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { getSession, listSessions, patchSession, putSession, removeSession } from './session-store';
import { getAdapter } from './adapters';
import type {
  AgentCommand,
  AgentFollowUpDto,
  AgentStatus,
  AgentType,
  CreateAgentSessionDto,
  ExternalAgentSession,
  NormalizedEvent,
  PermissionMode,
} from './types';

const DEV_AGENT_URL = process.env.DEV_AGENT_URL || 'http://localhost:8008';
const MCP_SERVER_URL_FOR_CHILD =
  process.env.OASIS_MCP_SERVER_URL || 'http://localhost:8020/mcp';

function iso(): string { return new Date().toISOString(); }

function buildMcpConfigJson(url: string): string {
  return JSON.stringify({
    mcpServers: {
      oasis: { type: 'http', url },
    },
  });
}

export class ExternalAgentsService {
  private readonly watching = new Set<string>();
  private readonly extraArgsBySession = new Map<string, string[]>();

  async createSession(dto: CreateAgentSessionDto): Promise<ExternalAgentSession> {
    const goal = dto.goal?.trim();
    if (!goal) throw new Error('goal is required');

    const session_id = uuidv4();

    let resolvedAgentType: AgentType;
    let resolvedPermissionMode: PermissionMode;
    let resolvedMcpEnabled: boolean;
    let resolvedModel: string | undefined;
    let resolvedPreamble: string | undefined;
    let resolvedExtraArgs: string[] = [];
    let resolvedProfileId: string | undefined;
    let resolvedRoleId: string | undefined;

    if (dto.resolved_profile) {
      const p = dto.resolved_profile;
      resolvedProfileId = p.profile_id;
      resolvedAgentType = p.agent_type;
      resolvedPermissionMode = p.permission_mode || 'acceptEdits';
      resolvedMcpEnabled = p.mcp_enabled ?? (p.agent_type === 'claude-code');
      resolvedModel = p.model;
      resolvedPreamble = p.system_prompt_preamble?.trim() || undefined;
      resolvedExtraArgs = p.extra_args ?? [];
    } else {
      resolvedAgentType = dto.agent_type || 'claude-code';
      resolvedPermissionMode = dto.permission_mode || 'acceptEdits';
      resolvedMcpEnabled = dto.mcp_enabled ?? true;
    }

    if (dto.resolved_role) {
      resolvedRoleId = dto.resolved_role.role_id;
      const roleText = dto.resolved_role.description?.trim();
      if (roleText) {
        resolvedPreamble = resolvedPreamble
          ? `${roleText}\n\n${resolvedPreamble}`
          : roleText;
      }
    }

    if (resolvedAgentType === 'cursor-cli' && resolvedMcpEnabled) {
      console.warn(
        `cursor-cli does not support per-session MCP loopback; mcp_enabled ignored for session ${session_id}.`,
      );
      resolvedMcpEnabled = false;
    }

    const agent_type = resolvedAgentType;
    const permission_mode = resolvedPermissionMode;
    const mcp_enabled = resolvedMcpEnabled;

    const worktree_name = dto.worktree_name || `agent-${session_id.slice(0, 8)}`;

    console.log(`Creating ${agent_type} session ${session_id}: "${goal.slice(0, 80)}"`);

    // 1) Create worktree via dev-agent
    let worktree: { worktree_id: string; worktree_path: string; branch: string; project_path: string };
    try {
      const res = await axios.post(
        `${DEV_AGENT_URL}/internal/dev-agent/worktrees/create`,
        { name: worktree_name },
        { timeout: 30_000 },
      );
      const data = res.data;
      if (!data?.ok || !data?.worktree_id) {
        throw new Error(data?.error || 'create_worktree returned no data');
      }
      worktree = {
        worktree_id: data.worktree_id,
        worktree_path: data.worktree_path,
        branch: data.branch || worktree_name,
        project_path: data.project_path || dto.project_path || '',
      };
    } catch (err: any) {
      console.error(`Failed to create worktree: ${err.message}`);
      throw new Error(`Dev-agent unavailable or worktree creation failed: ${err.message}`);
    }

    // 2) Prepare session dir + MCP config via dev-agent
    let session_dir: string;
    let transcript_path: string;
    let mcp_config_path: string | undefined;
    try {
      const prepRes = await axios.post(
        `${DEV_AGENT_URL}/internal/dev-agent/agent/prepare`,
        {
          session_id,
          mcp_config_json: mcp_enabled ? buildMcpConfigJson(MCP_SERVER_URL_FOR_CHILD) : null,
        },
        { timeout: 10_000 },
      );
      const d = prepRes.data;
      if (!d?.ok) throw new Error(d?.error || 'prepare failed');
      session_dir = d.session_dir;
      transcript_path = d.transcript_path;
      mcp_config_path = d.mcp_config_path || undefined;
    } catch (err: any) {
      await this.tryDiscardWorktree(worktree.worktree_id);
      throw new Error(`Agent prepare failed: ${err.message}`);
    }

    // 3) Build session record
    const session: ExternalAgentSession = {
      session_id,
      agent_type,
      goal,
      project_path: worktree.project_path || dto.project_path || '',
      worktree_id: worktree.worktree_id,
      worktree_path: worktree.worktree_path,
      branch: worktree.branch,
      base_branch: dto.base_branch,
      permission_mode,
      mcp_enabled,
      profile_id: resolvedProfileId,
      role_id: resolvedRoleId,
      model: resolvedModel,
      system_prompt_preamble: resolvedPreamble,
      status: 'creating',
      transcript_path,
      mcp_config_path,
      turn_count: 0,
      created_at: iso(),
      updated_at: iso(),
    };
    putSession(session);
    if (resolvedExtraArgs.length > 0) {
      this.extraArgsBySession.set(session_id, resolvedExtraArgs);
    }

    // 4) Build adapter command + spawn via dev-agent
    const adapter = getAdapter(agent_type);
    const extraArgs = this.extraArgsBySession.get(session_id);
    const command: AgentCommand = adapter.buildInitialCommand(session, mcp_config_path, extraArgs);

    try {
      await this.spawnChild(session, command);
    } catch (err: any) {
      patchSession(session_id, { status: 'failed', error: err.message });
      await this.tryDiscardWorktree(worktree.worktree_id);
      throw new Error(`Spawn failed: ${err.message}`);
    }

    return getSession(session_id)!;
  }

  async followUp(session_id: string, dto: AgentFollowUpDto): Promise<ExternalAgentSession> {
    const session = getSession(session_id);
    if (!session) throw new Error('session not found');
    const message = dto.message?.trim();
    if (!message) throw new Error('message is required');

    if (!['awaiting_merge', 'failed'].includes(session.status)) {
      throw new Error(`Cannot send follow-up while status=${session.status}`);
    }

    const adapter = getAdapter(session.agent_type);
    const extraArgs = this.extraArgsBySession.get(session.session_id);
    const command = adapter.buildFollowUpCommand(session, message, session.mcp_config_path, extraArgs);
    await this.spawnChild(session, command);
    return getSession(session_id)!;
  }

  async merge(session_id: string, commit_message?: string): Promise<ExternalAgentSession> {
    const session = getSession(session_id);
    if (!session) throw new Error('session not found');
    if (session.status !== 'awaiting_merge') {
      throw new Error(`Cannot merge while status=${session.status}`);
    }
    try {
      const res = await axios.post(
        `${DEV_AGENT_URL}/internal/dev-agent/apply`,
        {
          worktree_id: session.worktree_id,
          commit_message: commit_message || `[agent ${session.agent_type}] ${session.goal.slice(0, 72)}`,
        },
        { timeout: 60_000 },
      );
      if (!res.data?.success) {
        throw new Error(res.data?.error || 'apply returned failure');
      }
    } catch (err: any) {
      throw new Error(`Merge failed: ${err.message}`);
    }
    patchSession(session_id, { status: 'merged' });
    return getSession(session_id)!;
  }

  async discard(session_id: string): Promise<ExternalAgentSession> {
    const session = getSession(session_id);
    if (!session) throw new Error('session not found');
    if (session.status === 'running') {
      await this.cancel(session_id).catch(() => {});
    }
    await this.tryDiscardWorktree(session.worktree_id);
    patchSession(session_id, { status: 'discarded' });
    return getSession(session_id)!;
  }

  async cancel(session_id: string): Promise<ExternalAgentSession> {
    const session = getSession(session_id);
    if (!session) throw new Error('session not found');
    try {
      await axios.post(
        `${DEV_AGENT_URL}/internal/dev-agent/agent/${session_id}/cancel`,
        {},
        { timeout: 10_000 },
      );
    } catch (err: any) {
      console.warn(`Cancel RPC failed: ${err.message}`);
    }
    patchSession(session_id, { status: 'cancelled' });
    return getSession(session_id)!;
  }

  async remove(session_id: string): Promise<{ removed: boolean }> {
    const session = getSession(session_id);
    if (!session) return { removed: false };
    if (session.status === 'running') {
      await this.cancel(session_id).catch(() => {});
    }
    if (!['merged', 'discarded', 'cancelled'].includes(session.status)) {
      await this.tryDiscardWorktree(session.worktree_id);
    }
    await axios
      .delete(`${DEV_AGENT_URL}/internal/dev-agent/agent/${session_id}`, { timeout: 5_000 })
      .catch(() => {});
    return { removed: removeSession(session_id) };
  }

  list() { return listSessions().map(s => ({ ...s, diff: undefined })); }

  get(id: string) {
    const s = getSession(id);
    if (!s) throw new Error('session not found');
    return s;
  }

  async getTranscript(id: string): Promise<NormalizedEvent[]> {
    const session = this.get(id);
    const adapter = getAdapter(session.agent_type);
    const res = await axios.get(
      `${DEV_AGENT_URL}/internal/dev-agent/agent/${id}/tail`,
      { params: { offset: 0, follow: 0 }, responseType: 'text', transformResponse: x => x, timeout: 30_000 },
    );
    const text = typeof res.data === 'string' ? res.data : String(res.data ?? '');
    const events: NormalizedEvent[] = [];
    for (const line of text.split('\n')) {
      const evt = adapter.parseStreamEvent(line);
      if (evt) events.push(evt);
    }
    return events;
  }

  async getDiff(id: string): Promise<string> {
    const session = this.get(id);
    try {
      const res = await axios.get(
        `${DEV_AGENT_URL}/internal/dev-agent/diff/${session.worktree_id}`,
        { timeout: 20_000 },
      );
      const diff = typeof res.data === 'string' ? res.data : (res.data?.diff ?? '');
      patchSession(id, { diff });
      return diff;
    } catch (err: any) {
      throw new Error(`Diff unavailable: ${err.message}`);
    }
  }

  async *tailEvents(session_id: string): AsyncGenerator<NormalizedEvent> {
    const session = this.get(session_id);
    const adapter = getAdapter(session.agent_type);
    const res = await axios.get(
      `${DEV_AGENT_URL}/internal/dev-agent/agent/${session_id}/tail`,
      { params: { offset: 0, follow: 1 }, responseType: 'stream', timeout: 0 },
    );
    let buffer = '';
    const stream = res.data as NodeJS.ReadableStream;
    for await (const chunk of stream) {
      buffer += (chunk as Buffer).toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const evt = adapter.parseStreamEvent(line);
        if (evt) yield evt;
      }
    }
    if (buffer.trim()) {
      const evt = adapter.parseStreamEvent(buffer);
      if (evt) yield evt;
    }
  }

  private async spawnChild(session: ExternalAgentSession, command: AgentCommand): Promise<void> {
    const spawnRes = await axios.post(
      `${DEV_AGENT_URL}/internal/dev-agent/agent/spawn`,
      {
        session_id: session.session_id,
        cmd: command.cmd,
        args: command.args,
        env: command.env || null,
        cwd: session.worktree_path,
        transcript_path: session.transcript_path,
      },
      { timeout: 15_000 },
    );
    const d = spawnRes.data;
    if (!d?.ok) throw new Error(d?.error || 'spawn returned no ok');
    patchSession(session.session_id, {
      status: 'running',
      pid: d.pid,
      turn_count: (session.turn_count || 0) + 1,
    });
    this.startWatcher(session.session_id);
  }

  private startWatcher(session_id: string): void {
    if (this.watching.has(session_id)) return;
    this.watching.add(session_id);

    const tick = async () => {
      if (!this.watching.has(session_id)) return;
      const session = getSession(session_id);
      if (!session) { this.watching.delete(session_id); return; }
      if (['cancelled', 'merged', 'discarded'].includes(session.status)) {
        this.watching.delete(session_id);
        return;
      }
      try {
        const res = await axios.get(
          `${DEV_AGENT_URL}/internal/dev-agent/agent/${session_id}/status`,
          { timeout: 5_000 },
        );
        const d = res.data;
        if (d?.known && d.alive === false) {
          const exitCode = d.exit_code;
          const events = await this.getTranscript(session_id).catch(() => [] as NormalizedEvent[]);
          const adapter = getAdapter(session.agent_type);
          const summary = adapter.summarise(events);
          const nextStatus: AgentStatus = exitCode === 0 ? 'awaiting_merge' : 'failed';
          patchSession(session_id, {
            status: nextStatus,
            exit_code: exitCode,
            ...summary,
            error: exitCode === 0 ? undefined : `child exited with code ${exitCode}`,
          });
          this.watching.delete(session_id);
          return;
        }
      } catch (err: any) {
        console.debug(`watcher tick error (${session_id}): ${err.message}`);
      }
      setTimeout(tick, 1500);
    };
    setTimeout(tick, 500);
  }

  private async tryDiscardWorktree(worktree_id: string): Promise<void> {
    try {
      await axios.delete(
        `${DEV_AGENT_URL}/internal/dev-agent/worktree/${worktree_id}`,
        { timeout: 15_000 },
      );
    } catch (err: any) {
      console.warn(`discard worktree failed (${worktree_id}): ${err.message}`);
    }
  }
}
