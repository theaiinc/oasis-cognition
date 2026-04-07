import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const GRAPH_BUILDER_URL = process.env.GRAPH_BUILDER_URL || 'http://localhost:8002';
const LOGIC_ENGINE_URL = process.env.LOGIC_ENGINE_URL || 'http://localhost:8003';
const MEMORY_URL = process.env.MEMORY_URL || 'http://localhost:8004';
const RESPONSE_URL = process.env.RESPONSE_URL || 'http://localhost:8005';

const LLM_TIMEOUT_MS = 300_000;
const FAST_TIMEOUT_MS = 30_000;

async function axiosWithRetry(
  method: 'get' | 'post' | 'patch' | 'delete',
  url: string,
  data?: any,
  params?: any,
  opts?: { timeout?: number; retries?: number },
): Promise<any> {
  const timeout = opts?.timeout ?? FAST_TIMEOUT_MS;
  const retries = opts?.retries ?? 2;
  let lastErr: any = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (method === 'get') {
        const res = await axios.get(url, { params, timeout });
        return res.data;
      }
      if (method === 'delete') {
        const res = await axios.delete(url, { data, params, timeout });
        return res.data;
      }
      if (method === 'patch') {
        const res = await axios.patch(url, data, { params, timeout });
        return res.data;
      }
      const res = await axios.post(url, data, { params, timeout });
      return res.data;
    } catch (e: any) {
      lastErr = e;
      const code = e?.response?.status;
      const transient = code == null || code >= 500;
      if (!transient) throw e;
      if (attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastErr;
}

@Injectable()
export class SelfTeachingService {
  private readonly logger = new Logger(SelfTeachingService.name);

  private buildSemanticForTopic(topic: string) {
    // Minimal SemanticStructure for graph builder. We don't need interpreter routing here.
    return {
      problem: topic,
      trigger: '',
      entities: {},
      intent: 'explain',
      context: {},
      raw_input: topic,
      route: 'complex',
      is_simple: false,
    };
  }

  /**
   * Choose which rule_actions to apply: explicit path, merge all paths, or default top-level rule_actions.
   */
  private resolveRuleActionsForApprove(
    teachingPlan: Record<string, unknown>,
    opts?: { selected_teaching_path_id?: string; apply_all_teaching_paths?: boolean },
  ): any[] {
    const applyAll = Boolean(opts?.apply_all_teaching_paths);
    const pathId = opts?.selected_teaching_path_id;
    const paths = teachingPlan?.teaching_paths;

    if (applyAll && Array.isArray(paths) && paths.length > 0) {
      const merged: any[] = [];
      for (const p of paths as any[]) {
        const ra = p?.rule_actions;
        if (Array.isArray(ra)) merged.push(...ra);
      }
      return merged;
    }

    if (pathId && Array.isArray(paths)) {
      const found = (paths as any[]).find((p) => p?.path_id === pathId);
      if (found && Array.isArray(found.rule_actions) && found.rule_actions.length > 0) {
        return found.rule_actions;
      }
    }

    const top = teachingPlan?.rule_actions;
    return Array.isArray(top) ? top : [];
  }

  async start(topic: string) {
    const selfTeachingId = uuidv4();

    // Snapshot rules BEFORE we apply any teaching.
    const snapshotRes = await axiosWithRetry(
      'post',
      `${MEMORY_URL}/internal/memory/rules/snapshot`,
      { session_id: selfTeachingId },
      undefined,
      { timeout: FAST_TIMEOUT_MS, retries: 1 },
    );
    const rules_snapshot_id = snapshotRes?.snapshot_id ?? null;

    // Step 2: LLM tries to solve it by thought (candidate thoughts).
    const thoughtsRes = await axiosWithRetry(
      'post',
      `${RESPONSE_URL}/internal/thought/generate`,
      { user_message: topic },
      undefined,
      { timeout: LLM_TIMEOUT_MS, retries: 0 },
    );
    const rawThoughts = thoughtsRes?.thoughts ?? [];

    // Optionally validate thoughts with logic engine.
    const validateRes = await axiosWithRetry(
      'post',
      `${LOGIC_ENGINE_URL}/internal/reason/validate-thoughts`,
      { thoughts: rawThoughts, memory_context: [], rules: [], walls_hit: [], tool_results: [] },
      undefined,
      { timeout: FAST_TIMEOUT_MS, retries: 1 },
    );
    const llm_thoughts = validateRes?.validated_thoughts ?? [];

    // Step 3: Logic agent solves it using reasoning graph.
    const semantic = this.buildSemanticForTopic(topic);
    const graphRes = await axiosWithRetry(
      'post',
      `${GRAPH_BUILDER_URL}/internal/graph/build`,
      { semantic_structure: semantic, session_id: selfTeachingId },
      undefined,
      { timeout: FAST_TIMEOUT_MS, retries: 1 },
    );
    const reasoningGraph = graphRes?.reasoning_graph ?? {};
    const reasonRes = await axiosWithRetry(
      'post',
      `${LOGIC_ENGINE_URL}/internal/reason`,
      { reasoning_graph: reasoningGraph, memory_context: [], memory_stale_hint: null },
      undefined,
      { timeout: FAST_TIMEOUT_MS, retries: 1 },
    );
    const decisionTree = reasonRes?.decision_tree ?? {};
    const logic_solution = {
      conclusion: decisionTree?.conclusion ?? '',
      confidence: Number(reasonRes?.confidence ?? decisionTree?.confidence ?? 0),
      reasoning_trace: decisionTree?.reasoning_trace ?? [],
      hypotheses: decisionTree?.hypotheses ?? [],
    };

    // Step 4: LLM proposes a teaching plan for the logic agent.
    const planRes = await axiosWithRetry(
      'post',
      `${RESPONSE_URL}/internal/self-teaching/plan`,
      {
        topic,
        llm_thoughts,
        logic_solution,
      },
      undefined,
      { timeout: LLM_TIMEOUT_MS, retries: 0 },
    );
    const teaching_plan = planRes?.teaching_plan ?? planRes;

    // Persist pending workflow state.
    await axiosWithRetry(
      'post',
      `${MEMORY_URL}/internal/memory/self-teaching/pending`,
      {
        self_teaching_id: selfTeachingId,
        topic,
        rules_snapshot_id,
        llm_thoughts,
        logic_solution,
        teaching_plan,
      },
      undefined,
      { timeout: FAST_TIMEOUT_MS, retries: 1 },
    );

    return {
      self_teaching_id: selfTeachingId,
      llm_thoughts,
      logic_solution,
      teaching_plan,
    };
  }

  async adjust(selfTeachingId: string, userComment: string) {
    const trimmed = (userComment ?? '').trim();
    if (!trimmed) throw new Error('user_comment is required');

    const pending = await axiosWithRetry(
      'get',
      `${MEMORY_URL}/internal/memory/self-teaching/pending`,
      undefined,
      { self_teaching_id: selfTeachingId },
      { timeout: FAST_TIMEOUT_MS, retries: 0 },
    );

    if (!pending || Object.keys(pending).length === 0) {
      throw new Error('Pending self-teaching state not found');
    }

    const topic = pending?.topic ?? '';
    const llm_thoughts = pending?.llm_thoughts ?? [];
    const logic_solution = pending?.logic_solution ?? {};
    const rules_snapshot_id = pending?.rules_snapshot_id ?? pending?.snapshot_id ?? null;

    const priorPlan = pending?.teaching_plan && typeof pending.teaching_plan === 'object' ? pending.teaching_plan : null;

    const planRes = await axiosWithRetry(
      'post',
      `${RESPONSE_URL}/internal/self-teaching/plan`,
      {
        topic,
        llm_thoughts,
        logic_solution,
        user_comment: trimmed,
        prior_plan: priorPlan,
      },
      undefined,
      { timeout: LLM_TIMEOUT_MS, retries: 0 },
    );

    const teaching_plan = planRes?.teaching_plan ?? planRes;

    // Overwrite pending state with updated plan (rules not applied yet).
    await axiosWithRetry(
      'post',
      `${MEMORY_URL}/internal/memory/self-teaching/pending`,
      {
        self_teaching_id: selfTeachingId,
        topic,
        rules_snapshot_id,
        llm_thoughts,
        logic_solution,
        teaching_plan,
      },
      undefined,
      { timeout: FAST_TIMEOUT_MS, retries: 1 },
    );

    return {
      self_teaching_id: selfTeachingId,
      teaching_plan,
      adjusted: true,
    };
  }

  async approve(
    selfTeachingId: string,
    opts?: { selected_teaching_path_id?: string; apply_all_teaching_paths?: boolean },
  ) {
    const pending = await axiosWithRetry(
      'get',
      `${MEMORY_URL}/internal/memory/self-teaching/pending`,
      undefined,
      { self_teaching_id: selfTeachingId },
      { timeout: FAST_TIMEOUT_MS, retries: 0 },
    );

    const rulesSnapshotId = pending?.rules_snapshot_id ?? pending?.snapshot_id ?? null;
    const teachingPlan = (pending?.teaching_plan ?? {}) as Record<string, unknown>;
    const ruleActions = this.resolveRuleActionsForApprove(teachingPlan, opts) as Array<any>;

    const applied_rule_results: Array<{ action_index: number; action: string; success: boolean; message: string }> = [];

    let completed = false;
    try {
      // Apply rule actions sequentially; rollback if any fails.
      for (let i = 0; i < ruleActions.length; i++) {
        const action = ruleActions[i];
        try {
          await this.applyRuleAction(action);
          applied_rule_results.push({
            action_index: i,
            action: action?.action ?? 'unknown',
            success: true,
            message: 'Applied successfully',
          });
        } catch (e: any) {
          applied_rule_results.push({
            action_index: i,
            action: action?.action ?? 'unknown',
            success: false,
            message: e?.message || 'Failed to apply rule action',
          });
          // Mark remaining as skipped.
          for (let j = i + 1; j < ruleActions.length; j++) {
            applied_rule_results.push({
              action_index: j,
              action: ruleActions[j]?.action ?? 'unknown',
              success: false,
              message: 'Skipped due to earlier failure',
            });
          }
          throw e;
        }
      }
      completed = true;
    } catch (e: any) {
      if (rulesSnapshotId) {
        this.logger.warn(`Self-teaching apply failed; restoring rules snapshot=${rulesSnapshotId}`);
        try {
          await axiosWithRetry(
            'post',
            `${MEMORY_URL}/internal/memory/rules/restore`,
            { snapshot_id: rulesSnapshotId },
            undefined,
            { timeout: FAST_TIMEOUT_MS, retries: 0 },
          );
        } catch (restoreErr: any) {
          this.logger.warn(`Snapshot restore failed: ${restoreErr?.message || restoreErr}`);
        }
      }
      completed = false;
    } finally {
      // Clear pending state even if apply failed; user can restart if needed.
      try {
        await axiosWithRetry(
          'delete',
          `${MEMORY_URL}/internal/memory/self-teaching/pending`,
          undefined,
          { self_teaching_id: selfTeachingId },
          { timeout: FAST_TIMEOUT_MS, retries: 0 },
        );
      } catch {
        // best-effort
      }
    }

    return {
      self_teaching_id: selfTeachingId,
      teaching_started: true,
      completed,
      applied_rule_results,
    };
  }

  async reject(selfTeachingId: string) {
    try {
      await axiosWithRetry(
        'delete',
        `${MEMORY_URL}/internal/memory/self-teaching/pending`,
        undefined,
        { self_teaching_id: selfTeachingId },
        { timeout: FAST_TIMEOUT_MS, retries: 0 },
      );
    } catch {
      // best-effort
    }
    return { self_teaching_id: selfTeachingId, rejected: true };
  }

  private async applyRuleAction(action: any) {
    if (!action || typeof action !== 'object') throw new Error('Invalid rule action');
    const at = action.action;

    if (at === 'teach_rule') {
      // We support both shapes:
      // 1) { action:'teach_rule', condition?, conclusion }
      // 2) { action:'teach_rule', underlying_concept?, assertion }
      const conclusion = action.conclusion ?? action.assertion;
      const condition = action.condition ?? action.underlying_concept;
      if (!conclusion) throw new Error('teach_rule missing `conclusion`');

      const res = await axiosWithRetry(
        'post',
        `${MEMORY_URL}/internal/memory/teach`,
        {
          assertion: String(conclusion),
          category: action.category || 'rule',
          domain: action.domain || 'general',
          confidence: action.confidence ?? 0.8,
          supporting_sources: action.supporting_sources ?? [],
          underlying_concept: condition ? String(condition) : '',
        },
        undefined,
        { timeout: FAST_TIMEOUT_MS, retries: 0 },
      );

      this.logger.log(`teach_rule applied (memory_id=${res?.memory_id ?? 'n/a'})`);
      return;
    }

    if (at === 'update_rule') {
      if (!action.rule_id) throw new Error('update_rule missing `rule_id`');
      await axiosWithRetry(
        'patch',
        `${MEMORY_URL}/internal/memory/rules`,
        {
          rule_id: action.rule_id,
          condition: action.condition ?? undefined,
          conclusion: action.conclusion ?? undefined,
          confidence: action.confidence ?? undefined,
        },
        undefined,
        { timeout: FAST_TIMEOUT_MS, retries: 0 },
      );
      return;
    }

    if (at === 'delete_rule') {
      if (!action.rule_id) throw new Error('delete_rule missing `rule_id`');
      await axiosWithRetry(
        'delete',
        `${MEMORY_URL}/internal/memory/rules`,
        { rule_id: action.rule_id },
        undefined,
        { timeout: FAST_TIMEOUT_MS, retries: 0 },
      );
      return;
    }

    throw new Error(`Unsupported rule action: ${String(at)}`);
  }
}

