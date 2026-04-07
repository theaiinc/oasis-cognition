/**
 * Computer-Use security guard.
 *
 * Every browser action passes through this guard before execution.
 * It enforces the session's ComputerUsePolicy (whitelist / blacklist)
 * and ensures no step runs without an active, user-approved plan.
 */

import type { ComputerUsePolicy, PlanStep } from './computer-use.types';

/* ── Glob-style domain matching (supports * wildcards) ────────────────── */

function domainMatchesPattern(domain: string, pattern: string): boolean {
  // Convert glob to regex: * → [^.]*, *.bank.* → .*\.bank\..*
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex chars except *
    .replace(/\*/g, '.*');                  // * becomes .*
  try {
    return new RegExp(`^${escaped}$`, 'i').test(domain);
  } catch {
    return false;
  }
}

function extractDomain(urlOrTarget: string): string | null {
  try {
    const url = new URL(urlOrTarget.startsWith('http') ? urlOrTarget : `https://${urlOrTarget}`);
    return url.hostname + (url.port ? `:${url.port}` : '');
  } catch {
    return null;
  }
}

/* ── Public API ────────────────────────────────────────────────────────── */

export interface GuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check whether a proposed step is permitted under the session policy.
 * Returns `{ allowed: true }` or `{ allowed: false, reason }`.
 */
export function evaluateStepPolicy(
  step: PlanStep,
  policy: ComputerUsePolicy,
  context: {
    /** Has the user granted screen-vision permission? */
    visionGranted: boolean;
    /** Total steps already executed in this session. */
    stepsExecuted: number;
    /** Session start time (ISO). */
    sessionStartedAt: string;
  },
): GuardResult {
  // ── 0. Vision permission ──────────────────────────────────────────
  if (!context.visionGranted) {
    return { allowed: false, reason: 'Vision permission not granted. The user must explicitly allow screen vision before the agent can proceed.' };
  }

  // ── 1. Hard caps ──────────────────────────────────────────────────
  if (context.stepsExecuted >= policy.max_steps) {
    return { allowed: false, reason: `Step limit reached (${policy.max_steps}).` };
  }

  const elapsed = (Date.now() - new Date(context.sessionStartedAt).getTime()) / 1000;
  if (elapsed > policy.max_duration_seconds) {
    return { allowed: false, reason: `Session duration exceeded (${policy.max_duration_seconds}s).` };
  }

  // ── 2. Action whitelist / blacklist ───────────────────────────────
  const action = step.action.toLowerCase();

  if (policy.action_blacklist.length > 0) {
    if (policy.action_blacklist.some(b => action.includes(b.toLowerCase()))) {
      return { allowed: false, reason: `Action "${step.action}" is blacklisted.` };
    }
  }

  if (policy.action_whitelist.length > 0) {
    if (!policy.action_whitelist.some(w => action.includes(w.toLowerCase()))) {
      return { allowed: false, reason: `Action "${step.action}" is not in the whitelist.` };
    }
  }

  // ── 3. Domain whitelist / blacklist ───────────────────────────────
  const domain = step.target ? extractDomain(step.target) : null;

  if (domain) {
    // Blacklist always wins
    if (policy.domain_blacklist.length > 0) {
      if (policy.domain_blacklist.some(b => domainMatchesPattern(domain, b))) {
        return { allowed: false, reason: `Domain "${domain}" is blacklisted.` };
      }
    }

    // Whitelist: if set, domain must match at least one entry
    if (policy.domain_whitelist.length > 0) {
      if (!policy.domain_whitelist.some(w => domainMatchesPattern(domain, w))) {
        return { allowed: false, reason: `Domain "${domain}" is not in the whitelist.` };
      }
    }
  }

  return { allowed: true };
}

/**
 * Validate that a session is in a state where execution is allowed.
 * Prevents direct tool invocation outside an approved plan.
 */
export function validateSessionForExecution(session: {
  status: string;
  plan: PlanStep[];
  policy: ComputerUsePolicy;
  visionGranted: boolean;
}): GuardResult {
  if (!session.visionGranted) {
    return { allowed: false, reason: 'Cannot execute: user has not granted vision permission for this session.' };
  }

  if (session.status !== 'executing' && session.status !== 'paused') {
    return { allowed: false, reason: `Session status is "${session.status}"; execution requires "executing" or "paused".` };
  }

  if (session.plan.length === 0) {
    return { allowed: false, reason: 'No plan steps defined. A plan must be approved before execution.' };
  }

  return { allowed: true };
}
