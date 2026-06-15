// ── Shared types & enums ───────────────────────────────────────────────
export * from './types';

// ── Per-service contract schemas ───────────────────────────────────────
export * as memory from './memory';
export * as responseGenerator from './response-generator';
export * as interpreter from './interpreter';
export * as graphBuilder from './graph-builder';
export * as logicEngine from './logic-engine';
export * as observer from './observer';
export * as teaching from './teaching';
export * as devAgent from './dev-agent';
export * as artifact from './artifact';

// ── Validation wrapper ─────────────────────────────────────────────────
export { fetchContract } from './fetch-contract';
export type { FetchContractOptions } from './fetch-contract';
