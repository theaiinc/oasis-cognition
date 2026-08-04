/**
 * Native tool dispatchers for the Mission abstraction.
 *
 * These let the chat agent itself create / list / control background missions —
 * the layer that turns "watch my Zalo and draft replies" from an integration
 * project into a single chat message.
 *
 * Each call hits the gateway's own /api/v1/missions controller (one HTTP hop,
 * same process). When `mission_create` is called, we capture the *current*
 * chat session_id and use it as `notify_session_id` so digest cards land in
 * the conversation that asked for the mission.
 */

import axios from 'axios';

const GATEWAY_SELF = process.env.OASIS_GATEWAY_SELF_URL || 'http://localhost:8000';
const API = `${GATEWAY_SELF}/api/v1/missions`;

export interface NativeMissionPlan {
  tool: string;
  project_id?: string;
  /** Mission id for get/update/delete/pause/resume/run */
  mission_id?: string;
  /** Free-form description of what the mission should do */
  goal?: string;
  /** Override the prompt sent to the agent on each tick (defaults to goal) */
  prompt?: string;
  /** Cron expression — "*\/10 * * * *" / "0 9 * * 1-5" / etc. */
  schedule?: string;
  /** Connector id to bind (Phase 3) */
  connector_id?: string;
  /** Role/profile bindings */
  role_id?: string;
  profile_id?: string;
  /** "true" / "false" — string because LLM passes everything as strings */
  enabled?: string;
}

export interface NativeMissionResult {
  success: boolean;
  output: string;
}

export const NATIVE_MISSION_TOOLS = new Set<string>([
  'mission_create',
  'mission_list',
  'mission_get',
  'mission_update',
  'mission_delete',
  'mission_pause',
  'mission_resume',
  'mission_run',
]);

function asBool(v?: string): boolean | undefined {
  if (v == null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return undefined;
}

function fmtMission(m: any): string {
  const parts = [
    `${m.mission_id}`,
    `goal=${JSON.stringify(m.goal)}`,
    `schedule="${m.schedule}"`,
    `state=${m.state}`,
    `enabled=${m.enabled}`,
    `runs=${m.run_count ?? 0}`,
  ];
  if (m.next_run_at) parts.push(`next=${m.next_run_at}`);
  if (m.last_result) parts.push(`last_result="${String(m.last_result).slice(0, 120).replace(/\n/g, ' ⏎ ')}…"`);
  if (m.last_error) parts.push(`last_error="${String(m.last_error).slice(0, 120)}"`);
  return parts.join('  ');
}

async function doCreate(plan: NativeMissionPlan, sessionId: string): Promise<NativeMissionResult> {
  if (!plan.goal) return { success: false, output: 'mission_create requires PARAM_GOAL' };
  if (!plan.schedule) return { success: false, output: 'mission_create requires PARAM_SCHEDULE (cron expression)' };
  const res = await axios.post(API, {
    project_id: plan.project_id,
    goal: plan.goal,
    prompt: plan.prompt,
    schedule: plan.schedule,
    notify_session_id: sessionId,
    role_id: plan.role_id,
    profile_id: plan.profile_id,
    connector_id: plan.connector_id,
    enabled: asBool(plan.enabled) ?? true,
  });
  const m = res.data;
  return {
    success: true,
    output: `Mission created: ${m.mission_id}  goal=${JSON.stringify(m.goal)}  schedule="${m.schedule}"  next=${m.next_run_at || 'pending'}`,
  };
}

async function doList(_plan: NativeMissionPlan): Promise<NativeMissionResult> {
  const res = await axios.get(API);
  const list: any[] = res.data?.missions || [];
  if (list.length === 0) return { success: true, output: 'No missions running.' };
  return { success: true, output: `Missions (${list.length}):\n${list.map(m => '• ' + fmtMission(m)).join('\n')}` };
}

async function doGet(plan: NativeMissionPlan): Promise<NativeMissionResult> {
  if (!plan.mission_id) return { success: false, output: 'mission_get requires PARAM_MISSION_ID' };
  const res = await axios.get(`${API}/${plan.mission_id}`);
  return { success: true, output: fmtMission(res.data) };
}

async function doUpdate(plan: NativeMissionPlan): Promise<NativeMissionResult> {
  if (!plan.mission_id) return { success: false, output: 'mission_update requires PARAM_MISSION_ID' };
  const patch: Record<string, unknown> = {};
  if (plan.goal !== undefined) patch.goal = plan.goal;
  if (plan.prompt !== undefined) patch.prompt = plan.prompt;
  if (plan.schedule !== undefined) patch.schedule = plan.schedule;
  if (plan.role_id !== undefined) patch.role_id = plan.role_id;
  if (plan.profile_id !== undefined) patch.profile_id = plan.profile_id;
  if (plan.connector_id !== undefined) patch.connector_id = plan.connector_id;
  const eb = asBool(plan.enabled);
  if (eb !== undefined) patch.enabled = eb;
  const res = await axios.patch(`${API}/${plan.mission_id}`, patch);
  return { success: true, output: `Mission updated: ${fmtMission(res.data)}` };
}

async function doDelete(plan: NativeMissionPlan): Promise<NativeMissionResult> {
  if (!plan.mission_id) return { success: false, output: 'mission_delete requires PARAM_MISSION_ID' };
  await axios.delete(`${API}/${plan.mission_id}`);
  return { success: true, output: `Mission deleted: ${plan.mission_id}` };
}

async function doPause(plan: NativeMissionPlan): Promise<NativeMissionResult> {
  if (!plan.mission_id) return { success: false, output: 'mission_pause requires PARAM_MISSION_ID' };
  const res = await axios.post(`${API}/${plan.mission_id}/pause`);
  return { success: true, output: `Mission paused: ${fmtMission(res.data)}` };
}

async function doResume(plan: NativeMissionPlan): Promise<NativeMissionResult> {
  if (!plan.mission_id) return { success: false, output: 'mission_resume requires PARAM_MISSION_ID' };
  const res = await axios.post(`${API}/${plan.mission_id}/resume`);
  return { success: true, output: `Mission resumed: ${fmtMission(res.data)}` };
}

async function doRun(plan: NativeMissionPlan): Promise<NativeMissionResult> {
  if (!plan.mission_id) return { success: false, output: 'mission_run requires PARAM_MISSION_ID' };
  const res = await axios.post(`${API}/${plan.mission_id}/run`);
  return { success: true, output: `Mission tick triggered: ${fmtMission(res.data)} (running async; result will surface as a digest card)` };
}

const DISPATCHERS: Record<string, (plan: NativeMissionPlan, sessionId: string) => Promise<NativeMissionResult>> = {
  mission_create: doCreate,
  mission_list:   doList,
  mission_get:    doGet,
  mission_update: doUpdate,
  mission_delete: doDelete,
  mission_pause:  doPause,
  mission_resume: doResume,
  mission_run:    doRun,
};

export async function dispatchNativeMissionTool(plan: NativeMissionPlan, sessionId: string): Promise<NativeMissionResult> {
  const fn = DISPATCHERS[plan.tool];
  if (!fn) return { success: false, output: `unknown native mission tool: ${plan.tool}` };
  try {
    return await fn(plan, sessionId);
  } catch (err: any) {
    const detail = err?.response?.data?.message || err?.response?.data?.error || err?.message || String(err);
    return { success: false, output: `${plan.tool} failed: ${detail}` };
  }
}
