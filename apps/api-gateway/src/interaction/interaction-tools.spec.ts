/**
 * Unit tests for tool-calling infrastructure in InteractionService.
 *
 * Tests:
 * - Tool routing (DEV_AGENT_TOOLS vs TEXEC)
 * - Path normalization for dev-agent vs tool-executor
 * - Alias resolution
 * - Route correction logic
 * - Tool name canonicalization
 * - Error handling for missing params
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

// ── Tool sets (mirrored from interaction.service.ts) ─────────────────────
const DEV_AGENT_TOOLS = new Set([
  'create_worktree',
  'write_file',
  'edit_file',
  'apply_patch',
  'read_worktree_file',
  'get_diff',
  'bash',
  'computer_action',
]);

const TOOL_EXECUTOR_TOOLS = new Set([
  'read_file',
  'list_dir',
  'grep',
  'find_files',
  'browse_url',
]);

const GATEWAY_HANDLED_TOOLS = new Set([
  'search_artifacts',
  'read_artifact',
  'delegate_tasks',
  'delegate_job_status',
  'delegate_job_cancel',
  'delegate_job_results',
  'workflow_list', 'workflow_get', 'workflow_create', 'workflow_update', 'workflow_delete',
  'workflow_run', 'workflow_runs_list', 'workflow_get_run', 'workflow_cancel_run',
  'workflow_add_node', 'workflow_add_edge', 'workflow_remove_node',
  'node_catalog',
  'trigger_create', 'trigger_list', 'trigger_update', 'trigger_delete',
  'search_mcp',
  'search_skills',
]);

const DEV_AGENT_TOOLS_NEED_WORKTREE = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'read_worktree_file',
  'get_diff',
]);

const TOOL_NAME_ALIASES: Record<string, string> = {
  edit: 'edit_file',
  search_replace: 'edit_file',
  apply_patch: 'apply_patch',
  patch: 'apply_patch',
  unified_diff: 'apply_patch',
  replace: 'edit_file',
  delegate: 'delegate_tasks',
  parallel: 'delegate_tasks',
  spawn: 'delegate_tasks',
  cancel: 'delegate_job_cancel',
  get_results: 'delegate_job_results',
  discover_mcp: 'search_mcp',
  find_mcp: 'search_mcp',
  discover_skills: 'search_skills',
  find_skills: 'search_skills',
};

const EXPLORATION_TOOLS = new Set(['grep', 'find_files', 'list_dir', 'read_file', 'browse_url']);

// ── Helpers mirrored from interaction.service.ts ─────────────────────────

function isKnownExecutorTool(tool: string): boolean {
  return DEV_AGENT_TOOLS.has(tool) || TOOL_EXECUTOR_TOOLS.has(tool) || GATEWAY_HANDLED_TOOLS.has(tool);
}

function normalizeDevAgentFilePath(p: string): string {
  const s = p.trim();
  if (!s) return s;
  const norm = s.replace(/\\/g, '/');
  if (norm === '/workspace' || norm === '/workspace/') return '';
  if (norm.startsWith('/workspace/')) {
    const rest = norm.slice('/workspace/'.length).replace(/^\/+/, '');
    return rest || '';
  }
  return s;
}

function repairAmbiguousDevPath(p: string): string {
  const t = p.trim();
  if (t.endsWith('.') && !t.endsWith('..')) return t.slice(0, -1);
  return t;
}

function canonicalizeToolAlias(rawTool: string): { tool?: string; reason?: string } {
  const allowed = new Set<string>([...DEV_AGENT_TOOLS, ...TOOL_EXECUTOR_TOOLS, ...GATEWAY_HANDLED_TOOLS]);

  let s = (rawTool ?? '').toString().trim();
  // Strip common quoting artifacts from LLM outputs, e.g. ACTION: "grep"
  s = s.replace(/^["']/, '').replace(/["']$/, '');
  if (!s) return { reason: 'Missing tool name.' };

  const normalized = s.toLowerCase().trim().replace(/-/g, '_').replace(/\s+/g, '');

  // forbidden tools (desktop IDE/editor integrations)
  const forbidden = [
    'vscode', 'visualstudio', 'sublime', 'jetbrains', 'intellij', 'webstorm',
    'pycharm', 'atomeditor', 'zededitor', 'eclipse',
  ];
  if (forbidden.includes(normalized)) {
    return { reason: `${rawTool} is not a valid tool. Use read_file, edit_file, or bash.` };
  }

  if (allowed.has(normalized)) return { tool: normalized };

  // Auto-complete partial tool names
  const closest = [...allowed].filter(t => t.startsWith(normalized) || normalized.startsWith(t));
  if (closest.length === 1) return { tool: closest[0] };

  // Alias mapping
  const alias = TOOL_NAME_ALIASES[s.toLowerCase().replace(/-/g, '_')];
  if (alias) return { tool: alias };

  return { reason: `Unknown tool "${rawTool}". Must be one of: ${[...allowed].sort().join(', ')}.` };
}

// ── Tool routing test ────────────────────────────────────────────────────

describe('Tool Rounting', () => {

  it('routes read_file to tool-executor', () => {
    expect(TOOL_EXECUTOR_TOOLS.has('read_file')).toBe(true);
    expect(DEV_AGENT_TOOLS.has('read_file')).toBe(false);
  });

  it('routes grep to tool-executor', () => {
    expect(TOOL_EXECUTOR_TOOLS.has('grep')).toBe(true);
    expect(DEV_AGENT_TOOLS.has('grep')).toBe(false);
  });

  it('routes list_dir to tool-executor', () => {
    expect(TOOL_EXECUTOR_TOOLS.has('list_dir')).toBe(true);
    expect(DEV_AGENT_TOOLS.has('list_dir')).toBe(false);
  });

  it('routes find_files to tool-executor', () => {
    expect(TOOL_EXECUTOR_TOOLS.has('find_files')).toBe(true);
    expect(DEV_AGENT_TOOLS.has('find_files')).toBe(false);
  });

  it('routes browse_url to tool-executor', () => {
    expect(TOOL_EXECUTOR_TOOLS.has('browse_url')).toBe(true);
    expect(DEV_AGENT_TOOLS.has('browse_url')).toBe(false);
  });

  it('routes write_file to dev-agent', () => {
    expect(DEV_AGENT_TOOLS.has('write_file')).toBe(true);
    expect(TOOL_EXECUTOR_TOOLS.has('write_file')).toBe(false);
  });

  it('routes edit_file to dev-agent', () => {
    expect(DEV_AGENT_TOOLS.has('edit_file')).toBe(true);
    expect(TOOL_EXECUTOR_TOOLS.has('edit_file')).toBe(false);
  });

  it('routes bash to dev-agent', () => {
    expect(DEV_AGENT_TOOLS.has('bash')).toBe(true);
    expect(TOOL_EXECUTOR_TOOLS.has('bash')).toBe(false);
  });

  it('routes create_worktree to dev-agent', () => {
    expect(DEV_AGENT_TOOLS.has('create_worktree')).toBe(true);
  });

  it('routes apply_patch to dev-agent', () => {
    expect(DEV_AGENT_TOOLS.has('apply_patch')).toBe(true);
  });

  it('routes read_worktree_file to dev-agent', () => {
    expect(DEV_AGENT_TOOLS.has('read_worktree_file')).toBe(true);
  });

  it('routes get_diff to dev-agent', () => {
    expect(DEV_AGENT_TOOLS.has('get_diff')).toBe(true);
  });

  it('routes computer_action to dev-agent', () => {
    expect(DEV_AGENT_TOOLS.has('computer_action')).toBe(true);
  });

  it('routes search_artifacts to gateway', () => {
    expect(GATEWAY_HANDLED_TOOLS.has('search_artifacts')).toBe(true);
    expect(DEV_AGENT_TOOLS.has('search_artifacts')).toBe(false);
    expect(TOOL_EXECUTOR_TOOLS.has('search_artifacts')).toBe(false);
  });

  it('routes delegate_tasks to gateway', () => {
    expect(GATEWAY_HANDLED_TOOLS.has('delegate_tasks')).toBe(true);
  });

  it('routes delegate_job_status to gateway', () => {
    expect(GATEWAY_HANDLED_TOOLS.has('delegate_job_status')).toBe(true);
  });

  it('routes delegate_job_cancel to gateway', () => {
    expect(GATEWAY_HANDLED_TOOLS.has('delegate_job_cancel')).toBe(true);
  });

  it('routes delegate_job_results to gateway', () => {
    expect(GATEWAY_HANDLED_TOOLS.has('delegate_job_results')).toBe(true);
  });

  it('delegate_tasks is NOT in dev-agent or tool-executor', () => {
    expect(DEV_AGENT_TOOLS.has('delegate_tasks')).toBe(false);
    expect(TOOL_EXECUTOR_TOOLS.has('delegate_tasks')).toBe(false);
  });

  it('routes workflow tools to gateway', () => {
    expect(GATEWAY_HANDLED_TOOLS.has('workflow_list')).toBe(true);
    expect(GATEWAY_HANDLED_TOOLS.has('workflow_create')).toBe(true);
    expect(GATEWAY_HANDLED_TOOLS.has('workflow_run')).toBe(true);
  });

  it('isKnownExecutorTool returns true for all known tools', () => {
    for (const tool of [...DEV_AGENT_TOOLS, ...TOOL_EXECUTOR_TOOLS, ...GATEWAY_HANDLED_TOOLS]) {
      expect(isKnownExecutorTool(tool)).toBe(true);
    }
  });

  it('isKnownExecutorTool returns false for unknown tools', () => {
    expect(isKnownExecutorTool('unknown_tool')).toBe(false);
    expect(isKnownExecutorTool('')).toBe(false);
    expect(isKnownExecutorTool('vscode')).toBe(false);
  });

  it('write_file/edit_file/apply_patch/read_worktree_file/get_diff require worktree', () => {
    expect(DEV_AGENT_TOOLS_NEED_WORKTREE.has('write_file')).toBe(true);
    expect(DEV_AGENT_TOOLS_NEED_WORKTREE.has('edit_file')).toBe(true);
    expect(DEV_AGENT_TOOLS_NEED_WORKTREE.has('apply_patch')).toBe(true);
    expect(DEV_AGENT_TOOLS_NEED_WORKTREE.has('read_worktree_file')).toBe(true);
    expect(DEV_AGENT_TOOLS_NEED_WORKTREE.has('get_diff')).toBe(true);
    expect(DEV_AGENT_TOOLS_NEED_WORKTREE.has('bash')).toBe(false);
    expect(DEV_AGENT_TOOLS_NEED_WORKTREE.has('create_worktree')).toBe(false);
    expect(DEV_AGENT_TOOLS_NEED_WORKTREE.has('computer_action')).toBe(false);
  });
});

// ── Path normalization ───────────────────────────────────────────────────

describe('Path Normalization', () => {

  it('strips /workspace/ prefix from dev-agent paths', () => {
    expect(normalizeDevAgentFilePath('/workspace/apps/foo.ts')).toBe('apps/foo.ts');
    expect(normalizeDevAgentFilePath('/workspace/apps/api-gateway/src/main.ts')).toBe('apps/api-gateway/src/main.ts');
  });

  it('keeps paths without /workspace/ prefix unchanged', () => {
    expect(normalizeDevAgentFilePath('apps/foo.ts')).toBe('apps/foo.ts');
    expect(normalizeDevAgentFilePath('./apps/foo.ts')).toBe('./apps/foo.ts');
    expect(normalizeDevAgentFilePath('/etc/hosts')).toBe('/etc/hosts');
  });

  it('handles /workspace as root special case', () => {
    expect(normalizeDevAgentFilePath('/workspace')).toBe('');
    expect(normalizeDevAgentFilePath('/workspace/')).toBe('');
  });

  it('handles paths with forward slashes (unchanged)', () => {
    expect(normalizeDevAgentFilePath('apps/foo.ts')).toBe('apps/foo.ts');
  });

  it('strips trailing lone dot (ambiguous dev path)', () => {
    expect(repairAmbiguousDevPath('path/File.')).toBe('path/File');
    expect(repairAmbiguousDevPath('path/File.ts')).toBe('path/File.ts'); // no trailing dot
    expect(repairAmbiguousDevPath('..')).toBe('..'); // parent dir
    expect(repairAmbiguousDevPath('')).toBe('');
  });
});

// ── Tool alias resolution ────────────────────────────────────────────────

describe('Tool Alias Resolution', () => {

  it('resolves "edit" to "edit_file"', () => {
    const result = canonicalizeToolAlias('edit');
    expect(result.tool).toBe('edit_file');
    expect(result.reason).toBeUndefined();
  });

  it('resolves "search_replace" to "edit_file"', () => {
    expect(canonicalizeToolAlias('search_replace').tool).toBe('edit_file');
  });

  it('resolves "patch" to "apply_patch"', () => {
    expect(canonicalizeToolAlias('patch').tool).toBe('apply_patch');
  });

  it('resolves "unified_diff" to "apply_patch"', () => {
    expect(canonicalizeToolAlias('unified_diff').tool).toBe('apply_patch');
  });

  it('resolves "replace" to "edit_file"', () => {
    expect(canonicalizeToolAlias('replace').tool).toBe('edit_file');
  });

  it('passes through canonical tool names', () => {
    expect(canonicalizeToolAlias('read_file').tool).toBe('read_file');
    expect(canonicalizeToolAlias('grep').tool).toBe('grep');
    expect(canonicalizeToolAlias('bash').tool).toBe('bash');
    expect(canonicalizeToolAlias('write_file').tool).toBe('write_file');
  });

  it('rejects empty input', () => {
    const result = canonicalizeToolAlias('');
    expect(result.tool).toBeUndefined();
    expect(result.reason).toContain('Missing');
  });

  it('rejects null/undefined input', () => {
    expect(canonicalizeToolAlias(null as unknown as string).reason).toContain('Missing');
    expect(canonicalizeToolAlias(undefined as unknown as string).reason).toContain('Missing');
  });

  it('rejects forbidden IDE tool names', () => {
    expect(canonicalizeToolAlias('vscode').reason).toContain('not a valid tool');
    expect(canonicalizeToolAlias('intellij').reason).toContain('not a valid tool');
  });

  it('rejects truly unknown tool names', () => {
    expect(canonicalizeToolAlias('nonexistent_tool_xyz').reason).toContain('Unknown');
  });

  it('handles dashes by converting to underscores', () => {
    expect(canonicalizeToolAlias('read-file').tool).toBe('read_file');
    expect(canonicalizeToolAlias('apply-patch').tool).toBe('apply_patch');
  });

  it('strips surrounding quotes', () => {
    expect(canonicalizeToolAlias('"grep"').tool).toBe('grep');
    expect(canonicalizeToolAlias("'read_file'").tool).toBe('read_file');
  });

  it('resolves "delegate" to "delegate_tasks"', () => {
    expect(canonicalizeToolAlias('delegate').tool).toBe('delegate_tasks');
  });

  it('resolves "parallel" to "delegate_tasks"', () => {
    expect(canonicalizeToolAlias('parallel').tool).toBe('delegate_tasks');
  });

  it('resolves "delegate_tasks" directly (already canonical)', () => {
    expect(canonicalizeToolAlias('delegate_tasks').tool).toBe('delegate_tasks');
  });

  it('resolves "delegate_job_status" directly', () => {
    expect(canonicalizeToolAlias('delegate_job_status').tool).toBe('delegate_job_status');
  });

  it('resolves "get_results" to "delegate_job_results"', () => {
    expect(canonicalizeToolAlias('get_results').tool).toBe('delegate_job_results');
  });

  it('resolves "cancel" to "delegate_job_cancel"', () => {
    expect(canonicalizeToolAlias('cancel').tool).toBe('delegate_job_cancel');
  });

  // ── Discovery aliases ──

  it('resolves "discover_mcp" to "search_mcp"', () => {
    expect(canonicalizeToolAlias('discover_mcp').tool).toBe('search_mcp');
  });

  it('resolves "find_mcp" to "search_mcp"', () => {
    expect(canonicalizeToolAlias('find_mcp').tool).toBe('search_mcp');
  });

  it('resolves "discover_skills" to "search_skills"', () => {
    expect(canonicalizeToolAlias('discover_skills').tool).toBe('search_skills');
  });

  it('resolves "find_skills" to "search_skills"', () => {
    expect(canonicalizeToolAlias('find_skills').tool).toBe('search_skills');
  });

  it('resolves "search_mcp" directly (already canonical)', () => {
    expect(canonicalizeToolAlias('search_mcp').tool).toBe('search_mcp');
  });

  it('resolves "search_skills" directly (already canonical)', () => {
    expect(canonicalizeToolAlias('search_skills').tool).toBe('search_skills');
  });
});

// ── Exploration tools ────────────────────────────────────────────────────

describe('Exploration Tool Detection', () => {

  it('identifies read_file as exploration tool', () => {
    expect(EXPLORATION_TOOLS.has('read_file')).toBe(true);
  });

  it('identifies grep as exploration tool', () => {
    expect(EXPLORATION_TOOLS.has('grep')).toBe(true);
  });

  it('identifies find_files as exploration tool', () => {
    expect(EXPLORATION_TOOLS.has('find_files')).toBe(true);
  });

  it('identifies list_dir as exploration tool', () => {
    expect(EXPLORATION_TOOLS.has('list_dir')).toBe(true);
  });

  it('identifies browse_url as exploration tool', () => {
    expect(EXPLORATION_TOOLS.has('browse_url')).toBe(true);
  });

  it('does NOT identify write_file as exploration tool', () => {
    expect(EXPLORATION_TOOLS.has('write_file')).toBe(false);
  });

  it('does NOT identify bash as exploration tool', () => {
    expect(EXPLORATION_TOOLS.has('bash')).toBe(false);
  });

  it('does NOT identify edit_file as exploration tool', () => {
    expect(EXPLORATION_TOOLS.has('edit_file')).toBe(false);
  });
});

// ── Complete tool inventory (no tool should be orphaned or mis-categorized) ──

describe('Tool Inventory Completeness', () => {

  const ALL_KNOWN_TOOLS = [
    // Dev-agent
    'create_worktree', 'write_file', 'edit_file', 'apply_patch',
    'read_worktree_file', 'get_diff', 'bash', 'computer_action',
    // Tool-executor
    'read_file', 'list_dir', 'grep', 'find_files', 'browse_url',
    // Gateway-handled
    'search_artifacts', 'read_artifact',
    'delegate_tasks', 'delegate_job_status', 'delegate_job_cancel', 'delegate_job_results',
    'workflow_list', 'workflow_get', 'workflow_create', 'workflow_update', 'workflow_delete',
    'workflow_run', 'workflow_runs_list', 'workflow_get_run', 'workflow_cancel_run',
    'workflow_add_node', 'workflow_add_edge', 'workflow_remove_node',
    'node_catalog',
    'trigger_create', 'trigger_list', 'trigger_update', 'trigger_delete',
    // Discovery tools
    'search_mcp', 'search_skills',
  ];

  it('every tool is known by isKnownExecutorTool', () => {
    for (const t of ALL_KNOWN_TOOLS) {
      expect(isKnownExecutorTool(t)).toBe(true);
    }
  });

  it('every tool belongs to exactly one routing set', () => {
    for (const t of ALL_KNOWN_TOOLS) {
      const inDev = DEV_AGENT_TOOLS.has(t);
      const inExec = TOOL_EXECUTOR_TOOLS.has(t);
      const inGw = GATEWAY_HANDLED_TOOLS.has(t);
      const count = [inDev, inExec, inGw].filter(Boolean).length;
      expect(count).toBe(1); // exactly one routing
    }
  });

  it('every alias maps to a known tool', () => {
    for (const [, target] of Object.entries(TOOL_NAME_ALIASES)) {
      expect(isKnownExecutorTool(target)).toBe(true);
    }
  });

  it('dev-agent-needs-worktree is a subset of dev-agent', () => {
    for (const t of DEV_AGENT_TOOLS_NEED_WORKTREE) {
      expect(DEV_AGENT_TOOLS.has(t)).toBe(true);
    }
  });

  it('no tool is in both dev-agent and gateway-handled', () => {
    for (const t of DEV_AGENT_TOOLS) {
      expect(GATEWAY_HANDLED_TOOLS.has(t)).toBe(false);
    }
  });
});
