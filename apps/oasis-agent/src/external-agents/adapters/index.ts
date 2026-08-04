import type { AgentAdapter, AgentType } from '../types';
import { claudeCodeAdapter } from './claude-code';
import { cursorCliAdapter } from './cursor-cli';
import { openCodeAdapter } from './opencode';

const ADAPTERS: Record<AgentType, AgentAdapter> = {
  'claude-code': claudeCodeAdapter,
  'cursor-cli': cursorCliAdapter,
  'opencode': openCodeAdapter,
};

export function getAdapter(type: AgentType): AgentAdapter {
  const adapter = ADAPTERS[type];
  if (!adapter) throw new Error(`Unknown agent_type: ${type}`);
  return adapter;
}

export function listAdapterTypes(): AgentType[] {
  return Object.keys(ADAPTERS) as AgentType[];
}
