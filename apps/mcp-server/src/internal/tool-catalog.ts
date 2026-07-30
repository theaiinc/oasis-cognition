/**
 * Static tool catalog for `search_mcp` discovery.
 *
 * This is NOT an MCP tool — it's an internal HTTP endpoint that returns
 * the full catalog of MCP-registered tools grouped by category, so the
 * planner model can discover capabilities without having every tool in
 * its prompt.
 *
 * The catalog is static (tools are compiled into the mcp-server binary)
 * and intentionally mirrors the registration in ../server.ts.
 */

export interface ToolEntry {
  name: string;
  description: string;
  category: string;
}

const TOOL_CATALOG: ToolEntry[] = [
  // ── Computer Use ───────────────────────────────────────────────
  { name: 'cu_create_session', description: 'Create a new computer-use session.', category: 'computer_use' },
  { name: 'cu_list_sessions', description: 'List active computer-use sessions.', category: 'computer_use' },
  { name: 'cu_get_active_session', description: 'Get the active computer-use session.', category: 'computer_use' },
  { name: 'cu_get_session', description: 'Get a specific computer-use session by ID.', category: 'computer_use' },
  { name: 'cu_approve_plan', description: 'Approve a computer-use plan.', category: 'computer_use' },
  { name: 'cu_step_approve', description: 'Approve a single step in a computer-use plan.', category: 'computer_use' },
  { name: 'cu_pause_session', description: 'Pause a computer-use session.', category: 'computer_use' },
  { name: 'cu_resume_session', description: 'Resume a paused computer-use session.', category: 'computer_use' },
  { name: 'cu_send_feedback', description: 'Send feedback to a computer-use session.', category: 'computer_use' },
  { name: 'cu_add_user_note', description: 'Add a user note to a computer-use session.', category: 'computer_use' },
  { name: 'cu_cancel_session', description: 'Cancel a computer-use session.', category: 'computer_use' },
  { name: 'cu_update_policy', description: 'Update the computer-use policy.', category: 'computer_use' },
  { name: 'cu_get_default_policy', description: 'Get the default computer-use policy.', category: 'computer_use' },
  { name: 'cu_get_session_memory', description: 'Get memory of a computer-use session.', category: 'computer_use' },

  // ── Memory & Rules ────────────────────────────────────────────
  { name: 'memory_query', description: 'Semantic search over Oasis memory (facts, observations, past conclusions).', category: 'knowledge' },
  { name: 'memory_list_rules', description: 'List all rules in the logic engine.', category: 'knowledge' },
  { name: 'memory_rules_graph', description: 'Return the rule-dependency graph.', category: 'knowledge' },
  { name: 'memory_delete_rule', description: 'Delete a rule from the logic engine by id.', category: 'knowledge' },

  // ── Artifacts ─────────────────────────────────────────────────
  { name: 'artifact_search', description: 'Full-text / semantic search over indexed artifacts.', category: 'knowledge' },
  { name: 'artifact_list', description: 'List recent artifacts.', category: 'knowledge' },
  { name: 'artifact_get', description: 'Get an artifact by ID.', category: 'knowledge' },
  { name: 'artifact_summarize', description: 'Summarize an artifact.', category: 'knowledge' },
  { name: 'artifact_reprocess', description: 'Reprocess an artifact.', category: 'knowledge' },
  { name: 'artifact_from_youtube', description: 'Ingest a YouTube video as an artifact.', category: 'knowledge' },
  { name: 'artifact_delete', description: 'Delete an artifact.', category: 'knowledge' },
  { name: 'artifact_queue_status', description: 'Check artifact processing queue status.', category: 'knowledge' },

  // ── Interaction ───────────────────────────────────────────────
  { name: 'oasis_ask', description: 'Ask Oasis a question and get a natural-language answer.', category: 'interaction' },

  // ── Code Graph ────────────────────────────────────────────────
  { name: 'code_graph_status', description: 'Check code graph indexing status.', category: 'code' },
  { name: 'code_search_symbols', description: 'Fuzzy search over indexed code symbols (functions, classes, variables).', category: 'code' },
  { name: 'code_graph_snapshot', description: 'Take a snapshot of the current code graph.', category: 'code' },
  { name: 'code_reindex', description: 'Trigger a full re-index of the code graph.', category: 'code' },

  // ── Project ───────────────────────────────────────────────────
  { name: 'project_get_active', description: 'Get the active project.', category: 'project' },
  { name: 'project_get_context', description: 'Get project-level context.', category: 'project' },
  { name: 'project_get_config', description: 'Get project configuration.', category: 'project' },
  { name: 'project_activate', description: 'Activate a project.', category: 'project' },
  { name: 'project_configure', description: 'Configure a project.', category: 'project' },
  { name: 'project_reindex', description: 'Re-index a project.', category: 'project' },
  { name: 'project_get_settings', description: 'Get project settings.', category: 'project' },
  { name: 'project_save_settings', description: 'Save project settings.', category: 'project' },

  // ── History ───────────────────────────────────────────────────
  { name: 'history_list_sessions', description: 'List past chat sessions.', category: 'history' },
  { name: 'history_get_messages', description: 'Get messages from a session.', category: 'history' },
  { name: 'history_delete_session', description: 'Delete a session.', category: 'history' },

  // ── External Agents ───────────────────────────────────────────
  { name: 'agent_spawn', description: 'Spawn an external agent (e.g. Claude Code).', category: 'agents' },
  { name: 'agent_list_sessions', description: 'List external agent sessions.', category: 'agents' },
  { name: 'agent_get_session', description: 'Get an external agent session.', category: 'agents' },
  { name: 'agent_get_transcript', description: 'Get transcript of an external agent.', category: 'agents' },
  { name: 'agent_get_diff', description: 'Get diff from an external agent.', category: 'agents' },
  { name: 'agent_send_message', description: 'Send a message to an external agent.', category: 'agents' },
  { name: 'agent_merge', description: 'Merge changes from an external agent.', category: 'agents' },
  { name: 'agent_discard', description: 'Discard changes from an external agent.', category: 'agents' },
  { name: 'agent_cancel', description: 'Cancel an external agent.', category: 'agents' },
  { name: 'agent_remove', description: 'Remove an external agent.', category: 'agents' },

  // ── Workflows ─────────────────────────────────────────────────
  { name: 'node_catalog', description: 'List available workflow node types.', category: 'workflow' },
  { name: 'workflow_create', description: 'Create a new workflow.', category: 'workflow' },
  { name: 'workflow_list', description: 'List workflows.', category: 'workflow' },
  { name: 'workflow_get', description: 'Get a workflow by ID.', category: 'workflow' },
  { name: 'workflow_update', description: 'Update a workflow.', category: 'workflow' },
  { name: 'workflow_delete', description: 'Delete a workflow.', category: 'workflow' },
  { name: 'workflow_run', description: 'Run a workflow.', category: 'workflow' },
  { name: 'workflow_runs_list', description: 'List recent workflow runs.', category: 'workflow' },
  { name: 'workflow_get_run', description: 'Get a specific workflow run.', category: 'workflow' },
  { name: 'workflow_cancel_run', description: 'Cancel a running workflow.', category: 'workflow' },
  { name: 'trigger_create', description: 'Create a trigger for scheduled/reactive execution.', category: 'workflow' },
  { name: 'trigger_list', description: 'List triggers.', category: 'workflow' },
  { name: 'trigger_update', description: 'Update a trigger.', category: 'workflow' },
  { name: 'trigger_delete', description: 'Delete a trigger.', category: 'workflow' },

  // ── Web ────────────────────────────────────────────────────────
  { name: 'web_search', description: 'Search the web for information.', category: 'web' },

  // ── Agent Profiles ────────────────────────────────────────────
  { name: 'profile_list', description: 'List agent profiles.', category: 'profiles' },
  { name: 'profile_get', description: 'Get an agent profile by ID.', category: 'profiles' },
  { name: 'profile_create', description: 'Create an agent profile.', category: 'profiles' },
  { name: 'profile_update', description: 'Update an agent profile.', category: 'profiles' },
  { name: 'profile_delete', description: 'Delete an agent profile.', category: 'profiles' },

  // ── Project Roles ─────────────────────────────────────────────
  { name: 'role_list', description: 'List project roles.', category: 'profiles' },
  { name: 'role_get', description: 'Get a project role by ID.', category: 'profiles' },
  { name: 'role_create', description: 'Create a project role.', category: 'profiles' },
  { name: 'role_update', description: 'Update a project role.', category: 'profiles' },
  { name: 'role_delete', description: 'Delete a project role.', category: 'profiles' },
  { name: 'role_seed_presets', description: 'Seed default project roles.', category: 'profiles' },
];

/**
 * Search the tool catalog by keyword (name or description).
 * Returns top matches grouped by category.
 */
export function searchToolCatalog(query: string, maxResults = 10): ToolEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const scored = TOOL_CATALOG.map(t => {
    const nameMatch = t.name.toLowerCase().includes(q) ? 5 : 0;
    const descMatch = t.description.toLowerCase().includes(q) ? 2 : 0;
    const catMatch = t.category.toLowerCase().includes(q) ? 3 : 0;
    return { entry: t, score: nameMatch + descMatch + catMatch };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.entry);
}

/**
 * Get all available categories.
 */
export function getToolCategories(): string[] {
  return [...new Set(TOOL_CATALOG.map(t => t.category))].sort();
}

export default TOOL_CATALOG;
