import axios from 'axios';
import { OASIS_BASE_URL } from '@/lib/constants';

export type LlmThought = {
  thought: string;
  rationale?: string;
  confidence: number;
  validated?: boolean;
  rejection_reason?: string;
};

export type LogicSolution = {
  conclusion: string;
  confidence: number;
  reasoning_trace?: string[];
  hypotheses?: Array<{ title?: string; score?: number; eliminated?: boolean; category?: string }>;
};

export type TeachRuleAction =
  | {
      action: 'teach_rule';
      condition?: string;
      conclusion: string;
      subtopic_id?: string;
      category?: string;
      domain?: string;
      confidence?: number;
    }
  | {
      action: 'teach_rule';
      // Back-compat / alternative naming
      underlying_concept?: string;
      assertion: string;
      category?: string;
      domain?: string;
      confidence?: number;
    };

export type UpdateRuleAction = {
  action: 'update_rule';
  rule_id: string;
  condition?: string;
  conclusion?: string;
  confidence?: number;
};

export type DeleteRuleAction = {
  action: 'delete_rule';
  rule_id: string;
};

export type RuleAction = TeachRuleAction | UpdateRuleAction | DeleteRuleAction;

export type Subtopic = {
  id: string;
  title: string;
  summary?: string;
};

export type TeachingPath = {
  path_id: string;
  title: string;
  description?: string;
  rule_actions: RuleAction[];
};

export type TeachingPlan = {
  teaching_material: string;
  rule_actions: RuleAction[];
  /** How to accomplish the user’s multi-part task end-to-end */
  achievement_flow?: string;
  /** LLM-decomposed subtopics for compound problems */
  subtopics?: Subtopic[];
  /** Alternative bundles of rules (different ways to teach the logic engine) */
  teaching_paths?: TeachingPath[];
};

export type StartSelfTeachingResponse = {
  self_teaching_id: string;
  llm_thoughts: LlmThought[];
  logic_solution: LogicSolution;
  teaching_plan: TeachingPlan;
};

export type ApproveSelfTeachingResponse = {
  self_teaching_id: string;
  teaching_started: boolean;
  completed: boolean;
  applied_rule_results: Array<{
    action_index: number;
    action: string;
    success: boolean;
    message: string;
  }>;
};

export type AdjustSelfTeachingResponse = {
  self_teaching_id: string;
  teaching_plan: TeachingPlan;
  adjusted: boolean;
};

export type RejectSelfTeachingResponse = {
  self_teaching_id: string;
  rejected: boolean;
};

export type ApproveSelfTeachingOptions = {
  selected_teaching_path_id?: string;
  apply_all_teaching_paths?: boolean;
};

export async function startSelfTeaching(topic: string): Promise<StartSelfTeachingResponse> {
  const res = await axios.post(`${OASIS_BASE_URL}/api/v1/self-teaching/start`, { topic });
  return res.data as StartSelfTeachingResponse;
}

export async function approveSelfTeaching(
  selfTeachingId: string,
  options?: ApproveSelfTeachingOptions,
): Promise<ApproveSelfTeachingResponse> {
  const body: Record<string, unknown> = { self_teaching_id: selfTeachingId };
  if (options?.selected_teaching_path_id) {
    body.selected_teaching_path_id = options.selected_teaching_path_id;
  }
  if (options?.apply_all_teaching_paths) {
    body.apply_all_teaching_paths = true;
  }
  const res = await axios.post(`${OASIS_BASE_URL}/api/v1/self-teaching/approve`, body);
  return res.data as ApproveSelfTeachingResponse;
}

export async function adjustSelfTeaching(selfTeachingId: string, userComment: string): Promise<AdjustSelfTeachingResponse> {
  const res = await axios.post(`${OASIS_BASE_URL}/api/v1/self-teaching/adjust`, {
    self_teaching_id: selfTeachingId,
    user_comment: userComment,
  });
  return res.data as AdjustSelfTeachingResponse;
}

export async function rejectSelfTeaching(selfTeachingId: string): Promise<RejectSelfTeachingResponse> {
  const res = await axios.post(`${OASIS_BASE_URL}/api/v1/self-teaching/reject`, { self_teaching_id: selfTeachingId });
  return res.data as RejectSelfTeachingResponse;
}

