/**
 * Computer-use tools — drive the Oasis CU agent: create plan, approve, cancel,
 * steer via feedback, etc.
 *
 * All endpoints live under /api/v1/computer-use.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gwGet, gwPost, gwPatch, gwDelete } from '../lib/gateway.js';
import { handle } from '../lib/tool-utils.js';

const BASE = '/api/v1/computer-use';

export function registerComputerUseTools(server: McpServer) {
  server.tool(
    'cu_create_session',
    'Create a new computer-use session from a high-level goal. Returns the drafted plan for review. Call cu_approve_plan to start executing.',
    {
      goal: z.string().describe('Natural-language description of what to accomplish on the computer.'),
      capture_mode: z
        .enum(['screen', 'window', 'browser'])
        .optional()
        .describe('What to capture. Defaults to "screen".'),
      capture_target: z
        .string()
        .optional()
        .describe('Optional window/app title or URL hint, used with capture_mode.'),
    },
    async ({ goal, capture_mode, capture_target }) =>
      handle(() =>
        gwPost(`${BASE}/sessions`, {
          goal,
          capture_mode,
          capture_target,
        }),
      ),
  );

  server.tool(
    'cu_list_sessions',
    'List all known computer-use sessions (newest first). Screenshots are stripped.',
    {},
    async () => handle(() => gwGet(`${BASE}/sessions`)),
  );

  server.tool(
    'cu_get_active_session',
    'Get the currently active (non-terminal) CU session, or the most recently completed one.',
    {},
    async () => handle(() => gwGet(`${BASE}/sessions/active`)),
  );

  server.tool(
    'cu_get_session',
    'Get the full state of one CU session, including its plan, current step, and error (if any).',
    {
      session_id: z.string(),
    },
    async ({ session_id }) => handle(() => gwGet(`${BASE}/sessions/${session_id}`)),
  );

  server.tool(
    'cu_approve_plan',
    'Approve the drafted plan and start execution. Requires the user to have granted screen-vision access.',
    {
      session_id: z.string(),
      vision_granted: z
        .boolean()
        .default(true)
        .describe('Whether the user granted permission to see the screen.'),
    },
    async ({ session_id, vision_granted }) =>
      handle(() => gwPost(`${BASE}/sessions/${session_id}/approve`, { vision_granted })),
  );

  server.tool(
    'cu_step_approve',
    'Approve (or reject) a single pending step when the session is running in step-by-step mode.',
    {
      session_id: z.string(),
      step_index: z.number().int(),
      approved: z.boolean(),
      reason: z.string().optional(),
    },
    async ({ session_id, step_index, approved, reason }) =>
      handle(() =>
        gwPost(`${BASE}/sessions/${session_id}/step-approve`, {
          step_index,
          approved,
          reason,
        }),
      ),
  );

  server.tool(
    'cu_pause_session',
    'Pause a running CU session. Use cu_resume_session to continue.',
    { session_id: z.string() },
    async ({ session_id }) => handle(() => gwPost(`${BASE}/sessions/${session_id}/pause`)),
  );

  server.tool(
    'cu_resume_session',
    'Resume a paused CU session.',
    { session_id: z.string() },
    async ({ session_id }) => handle(() => gwPost(`${BASE}/sessions/${session_id}/resume`)),
  );

  server.tool(
    'cu_send_feedback',
    'Send mid-execution steering feedback to the CU agent (e.g. "the search bar is at the top-right").',
    {
      session_id: z.string(),
      feedback: z.string(),
    },
    async ({ session_id, feedback }) =>
      handle(() => gwPost(`${BASE}/sessions/${session_id}/feedback`, { feedback })),
  );

  server.tool(
    'cu_add_user_note',
    'Add a freeform note to the session\'s durable USER_NOTES.md. The agent reads these each iteration.',
    {
      session_id: z.string(),
      note: z.string(),
    },
    async ({ session_id, note }) =>
      handle(() => gwPost(`${BASE}/sessions/${session_id}/user-note`, { note })),
  );

  server.tool(
    'cu_follow_up',
    'After a plan completes, queue a follow-up goal without creating a brand-new session.',
    {
      session_id: z.string(),
      goal: z.string(),
    },
    async ({ session_id, goal }) =>
      handle(() => gwPost(`${BASE}/sessions/${session_id}/follow-up`, { goal })),
  );

  server.tool(
    'cu_cancel_session',
    'Cancel a CU session and stop any running steps.',
    { session_id: z.string() },
    async ({ session_id }) => handle(() => gwDelete(`${BASE}/sessions/${session_id}`)),
  );

  server.tool(
    'cu_update_policy',
    'Patch the execution policy of an existing session (timeouts, step-approval mode, domain whitelist, etc.).',
    {
      session_id: z.string(),
      policy: z.record(z.any()),
    },
    async ({ session_id, policy }) =>
      handle(() => gwPatch(`${BASE}/sessions/${session_id}/policy`, policy)),
  );

  server.tool(
    'cu_get_default_policy',
    'Get the default CU execution policy, useful when constructing a custom policy.',
    {},
    async () => handle(() => gwGet(`${BASE}/default-policy`)),
  );

  server.tool(
    'cu_get_session_memory',
    'Inspect a session\'s durable memory (SESSION.json, MEMORY.md, step artifacts, etc.).',
    { session_id: z.string() },
    async ({ session_id }) => handle(() => gwGet(`${BASE}/sessions/${session_id}/memory`)),
  );
}
