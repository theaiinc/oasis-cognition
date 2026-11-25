import axios from 'axios';
import { executeRun } from '../engine';
import { listParamSchemas, listRegisteredTypes } from '../node-registry';
import { registerBuiltins } from './builtin';
import { registerWebSearchNode } from './web-search';
import { searchWeb, WebSearchError } from '../../web-search/web-search.provider';
import type { Workflow, WorkflowRun } from '../workflows.types';

jest.mock('axios');
const mocked = axios as jest.Mocked<typeof axios>;

const ENV = ['OASIS_WEB_SEARCH_PROVIDER', 'OASIS_TAVILY_API_KEY', 'OASIS_BRAVE_SEARCH_API_KEY', 'TOOL_EXECUTOR_URL'];

beforeAll(() => {
  registerBuiltins();
  registerWebSearchNode();
});

beforeEach(() => {
  jest.resetAllMocks();
  for (const k of ENV) delete process.env[k];
});

const ddgReply = {
  data: {
    success: true,
    results: [
      { title: 'Release notes', url: 'https://example.com/notes', snippet: 'What changed' },
      { title: 'No url', url: '', snippet: 'dropped' },
      { title: 'Blog', url: 'https://example.com/blog', snippet: 'Post' },
    ],
  },
};

function workflow(): Workflow {
  const now = new Date().toISOString();
  return {
    workflow_id: 'wf-search',
    name: 'search',
    version: 1,
    enabled: true,
    nodes: [
      { id: 'in', type: 'input', params: {} },
      { id: 'search', type: 'web_search', params: { query: '{{input.topic}} release notes', limit: 2 } },
      { id: 'pick', type: 'transform', params: { expression: '{first: value[0].url, n: value|length}' } },
      { id: 'out', type: 'output', params: {} },
    ],
    edges: [
      { from_node: 'in', to_node: 'search' },
      { from_node: 'search', to_node: 'pick' },
      { from_node: 'pick', to_node: 'out' },
    ],
    created_at: now,
    updated_at: now,
  };
}

function run(input: any): WorkflowRun {
  return {
    run_id: 'run-search',
    workflow_id: 'wf-search',
    status: 'queued',
    input,
    context: {},
    node_states: {},
    created_at: new Date().toISOString(),
  } as WorkflowRun;
}

const store = { saveRun: jest.fn(async () => undefined), appendRunEvent: jest.fn(async () => undefined) } as any;

describe('web_search workflow node', () => {
  it('is in the node catalog with its param schema', () => {
    expect(listRegisteredTypes()).toContain('web_search');
    expect(listParamSchemas().web_search).toMatchObject({ required: ['query'], properties: { query: { type: 'string' } } });
  });

  it('runs input -> web_search -> transform -> output end to end', async () => {
    mocked.post.mockResolvedValueOnce(ddgReply);
    const result = await executeRun(run({ topic: 'Node 24' }), workflow(), store);

    expect(result.status).toBe('completed');
    expect(mocked.post).toHaveBeenCalledWith(
      expect.stringMatching(/\/internal\/tool\/execute$/),
      { tool: 'web_search', command: 'Node 24 release notes' },
      expect.anything(),
    );
    expect(result.output).toEqual({ first: 'https://example.com/notes', n: 2 });
  });

  it('fails the node when the query is empty after interpolation', async () => {
    const wf = workflow();
    wf.nodes[1].params = { query: '{{input.topic}}' };
    const result = await executeRun(run({}), wf, store);
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result.node_states.search)).toContain('params.query is required');
    expect(mocked.post).not.toHaveBeenCalled();
  });
});

describe('web search providers', () => {
  it('defaults to duckduckgo via the tool-executor and keeps the shape', async () => {
    mocked.post.mockResolvedValueOnce(ddgReply);
    const res = await searchWeb('x', { limit: 5 });
    expect(res.provider).toBe('duckduckgo');
    expect(res.results).toEqual([
      { title: 'Release notes', url: 'https://example.com/notes', snippet: 'What changed' },
      { title: 'Blog', url: 'https://example.com/blog', snippet: 'Post' },
    ]);
  });

  it('uses Tavily when configured', async () => {
    process.env.OASIS_WEB_SEARCH_PROVIDER = 'tavily';
    process.env.OASIS_TAVILY_API_KEY = 'test-key';
    mocked.post.mockResolvedValueOnce({ data: { results: [{ title: 'T', url: 'https://t.example', content: 'tavily snippet' }] } });
    const res = await searchWeb('x', { limit: 3 });
    expect(mocked.post).toHaveBeenCalledWith(
      'https://api.tavily.com/search',
      { query: 'x', max_results: 3 },
      expect.objectContaining({ headers: { Authorization: 'Bearer test-key' } }),
    );
    expect(res).toEqual({ provider: 'tavily', results: [{ title: 'T', url: 'https://t.example', snippet: 'tavily snippet' }] });
  });

  it('uses Brave when configured', async () => {
    process.env.OASIS_WEB_SEARCH_PROVIDER = 'Brave';
    process.env.OASIS_BRAVE_SEARCH_API_KEY = 'test-key';
    mocked.get.mockResolvedValueOnce({ data: { web: { results: [{ title: 'B', url: 'https://b.example', description: 'brave snippet' }] } } });
    const res = await searchWeb('x');
    expect(mocked.get).toHaveBeenCalledWith(
      'https://api.search.brave.com/res/v1/web/search',
      expect.objectContaining({ params: { q: 'x', count: 5 }, headers: expect.objectContaining({ 'X-Subscription-Token': 'test-key' }) }),
    );
    expect(res.results).toEqual([{ title: 'B', url: 'https://b.example', snippet: 'brave snippet' }]);
  });

  it('says which key is missing instead of falling back silently', async () => {
    process.env.OASIS_WEB_SEARCH_PROVIDER = 'tavily';
    await expect(searchWeb('x')).rejects.toThrow(new WebSearchError('OASIS_WEB_SEARCH_PROVIDER is tavily but OASIS_TAVILY_API_KEY is not set'));
  });

  it('treats an unknown provider as duckduckgo and caps the limit at 20', async () => {
    process.env.OASIS_WEB_SEARCH_PROVIDER = 'bing';
    mocked.post.mockResolvedValueOnce({ data: { success: true, results: Array.from({ length: 30 }, (_, i) => ({ title: `${i}`, url: `https://e.example/${i}`, snippet: '' })) } });
    const res = await searchWeb('x', { limit: 99 });
    expect(res.provider).toBe('duckduckgo');
    expect(res.results).toHaveLength(20);
  });
});
