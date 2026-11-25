/**
 * web_search node: search the web from inside a workflow.
 *
 * params:
 *   query:  string, required. Supports interpolation: "{{input.topic}} release notes" (the run's
 *           input) or "{{value.topic}}" (what the upstream node sent).
 *   limit?: number of results, 1-20 (default 5).
 *
 * Returns:
 *   out:  [{ title, url, snippet }, ...]  so a transform can JEXL over it,
 *         e.g. `value[0].url` or `value|length`.
 *   meta: { query, provider, count }
 *
 * The provider is the deployment's OASIS_WEB_SEARCH_PROVIDER (web-search.provider.ts),
 * so swapping DuckDuckGo for Tavily or Brave never changes a workflow.
 */

import { searchWeb } from '../../web-search/web-search.provider';
import { registerNode, type NodeExecutor, type NodeParamSchema } from '../node-registry';

export const WEB_SEARCH_PARAMS: NodeParamSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'What to search for. Supports {{...}} interpolation, e.g. {{input.query}} or {{value.query}}.' },
    limit: { type: 'integer', minimum: 1, maximum: 20, default: 5, description: 'How many results to return.' },
  },
  required: ['query'],
};

export const webSearchNode: NodeExecutor = async ({ node, abortSignal }) => {
  const query = String(node.params?.query ?? '').trim();
  if (!query) throw new Error('web_search node: params.query is required (it was empty after interpolation)');
  const { provider, results } = await searchWeb(query, { limit: node.params?.limit, signal: abortSignal });
  return { out: results, meta: { query, provider, count: results.length } };
};

export function registerWebSearchNode() {
  registerNode('web_search', webSearchNode, WEB_SEARCH_PARAMS);
}
