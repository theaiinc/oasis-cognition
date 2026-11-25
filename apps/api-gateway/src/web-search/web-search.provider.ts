/**
 * Web search, with the provider chosen by OASIS_WEB_SEARCH_PROVIDER.
 *
 *   duckduckgo (default)  the tool-executor's `web_search` tool, no key needed
 *   tavily                api.tavily.com, key in OASIS_TAVILY_API_KEY
 *   brave                 api.search.brave.com, key in OASIS_BRAVE_SEARCH_API_KEY
 *
 * Every provider returns the same shape, an array of {title, url, snippet}, so
 * callers (the /web-search endpoint, the `web_search` workflow node) never
 * depend on which one is configured. The teaching service reads the same
 * OASIS_WEB_SEARCH_PROVIDER / OASIS_TAVILY_API_KEY.
 */

import axios from 'axios';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const WEB_SEARCH_PROVIDERS = ['duckduckgo', 'tavily', 'brave'] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export const MAX_RESULTS = 20;

export class WebSearchError extends Error {}

export function configuredProvider(): WebSearchProvider {
  const raw = (process.env.OASIS_WEB_SEARCH_PROVIDER || 'duckduckgo').trim().toLowerCase();
  return (WEB_SEARCH_PROVIDERS as readonly string[]).includes(raw) ? (raw as WebSearchProvider) : 'duckduckgo';
}

export function clampLimit(value: unknown, fallback = 5): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_RESULTS, n) : fallback;
}

function clean(results: Array<Partial<WebSearchResult>>, limit: number): WebSearchResult[] {
  return results
    .map(r => ({ title: String(r.title ?? ''), url: String(r.url ?? ''), snippet: String(r.snippet ?? '') }))
    .filter(r => r.url)
    .slice(0, limit);
}

async function duckduckgo(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const base = process.env.TOOL_EXECUTOR_URL || 'http://localhost:8007';
  // tool-executor repurposes `command` for the search query.
  const res = await axios.post(`${base}/internal/tool/execute`, { tool: 'web_search', command: query }, { timeout: 30_000, signal });
  if (!res.data?.success) throw new WebSearchError(res.data?.output || res.data?.error || 'web_search failed');
  return clean(Array.isArray(res.data.results) ? res.data.results : [], limit);
}

async function tavily(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const key = process.env.OASIS_TAVILY_API_KEY;
  if (!key) throw new WebSearchError('OASIS_WEB_SEARCH_PROVIDER is tavily but OASIS_TAVILY_API_KEY is not set');
  const res = await axios.post(
    'https://api.tavily.com/search',
    { query, max_results: limit },
    { headers: { Authorization: `Bearer ${key}` }, timeout: 30_000, signal },
  );
  const items = Array.isArray(res.data?.results) ? res.data.results : [];
  return clean(items.map((r: any) => ({ title: r.title, url: r.url, snippet: r.content })), limit);
}

async function brave(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const key = process.env.OASIS_BRAVE_SEARCH_API_KEY;
  if (!key) throw new WebSearchError('OASIS_WEB_SEARCH_PROVIDER is brave but OASIS_BRAVE_SEARCH_API_KEY is not set');
  const res = await axios.get('https://api.search.brave.com/res/v1/web/search', {
    params: { q: query, count: limit },
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    timeout: 30_000,
    signal,
  });
  const items = Array.isArray(res.data?.web?.results) ? res.data.web.results : [];
  return clean(items.map((r: any) => ({ title: r.title, url: r.url, snippet: r.description })), limit);
}

const PROVIDERS: Record<WebSearchProvider, typeof duckduckgo> = { duckduckgo, tavily, brave };

/** Search the web with the configured provider. Throws WebSearchError when it can't. */
export async function searchWeb(
  query: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<{ provider: WebSearchProvider; results: WebSearchResult[] }> {
  const q = (query || '').trim();
  if (!q) throw new WebSearchError('query is required');
  const provider = configuredProvider();
  const limit = clampLimit(opts.limit);
  try {
    return { provider, results: await PROVIDERS[provider](q, limit, opts.signal) };
  } catch (err: any) {
    if (err instanceof WebSearchError) throw err;
    const status = err?.response?.status ? ` (HTTP ${err.response.status})` : '';
    throw new WebSearchError(`${provider} search failed${status}: ${err?.message || 'unknown error'}`);
  }
}
