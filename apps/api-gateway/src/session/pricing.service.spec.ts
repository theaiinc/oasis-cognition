import { PricingService } from './pricing.service';

// ── helpers ──────────────────────────────────────────────────────────

/** Create a fresh PricingService and initialise the table. */
function freshService(): PricingService {
  const svc = new PricingService();
  (svc as any).mergeTable();
  return svc;
}

/** Call private mergeTable.*/
function mergeTable(svc: PricingService, apiOverrides?: Record<string, any>) {
  (svc as any).mergeTable(apiOverrides);
}

/** Access internal table.*/
function getTable(svc: PricingService): Record<string, any> {
  return (svc as any).table;
}

/**
 * Create a PricingService whose `http.get` is mocked.
 * A convenience that avoids module-level jest.mock() issues with axios.
 */
function svcWithMockedHttp(): { svc: PricingService; mockGet: jest.Mock } {
  const svc = freshService();
  const mockGet = jest.fn();
  (svc as any).http = { get: mockGet };
  return { svc, mockGet };
}

const DEFAULT_ENTRY_COUNT = 22;

// ── tests ───────────────────────────────────────────────────────────

describe('PricingService', () => {
  let OENV: typeof process.env;

  beforeAll(() => { OENV = process.env; });
  beforeEach(() => {
    process.env = { ...OENV };
    delete process.env.OASIS_PRICING_API_URL;
    delete process.env.OASIS_MODEL_PRICING_JSON;
  });
  afterAll(() => { process.env = OENV; });

  // ────────────────────────────────────────────────────────────────
  // pricingFor
  // ────────────────────────────────────────────────────────────────

  describe('pricingFor', () => {
    it('returns null for null / undefined model', () => {
      const svc = freshService();
      expect(svc.pricingFor(null)).toBeNull();
      expect(svc.pricingFor(undefined)).toBeNull();
    });

    it('returns null for unknown model without provider', () => {
      const svc = freshService();
      expect(svc.pricingFor('nonexistent-model')).toBeNull();
    });

    it('returns null for unknown model with known provider', () => {
      const svc = freshService();
      expect(svc.pricingFor('bogus', 'anthropic:anthropic')).toBeNull();
    });

    it('matches composite exact (same router+provider)', () => {
      const svc = freshService();
      const p = svc.pricingFor('claude-sonnet-4-7', 'anthropic:anthropic');
      expect(p).not.toBeNull();
      expect(p!.input_per_1m_usd).toBe(3.0);
      expect(p!.output_per_1m_usd).toBe(15.0);
    });

    it('matches composite exact (llmapi gateway)', () => {
      const svc = freshService();
      const p = svc.pricingFor('deepseek-v4-flash', 'llmapi:deepseek');
      expect(p).not.toBeNull();
      expect(p!.input_per_1m_usd).toBe(0.20);
      expect(p!.output_per_1m_usd).toBe(0.80);
    });

    it('matches composite exact (deepseek first party)', () => {
      const svc = freshService();
      const p = svc.pricingFor('deepseek-v4-flash', 'deepseek:deepseek');
      expect(p).not.toBeNull();
      expect(p!.input_per_1m_usd).toBe(0.15);
      expect(p!.output_per_1m_usd).toBe(0.60);
    });

    it('matches composite exact for local model', () => {
      const svc = freshService();
      const p = svc.pricingFor('qwen3', 'ollama:ollama');
      expect(p).not.toBeNull();
      expect(p!.input_per_1m_usd).toBe(0);
    });

    it('matches composite prefix for date-tagged variant', () => {
      const svc = freshService();
      const p = svc.pricingFor('claude-sonnet-4-5-20260415', 'anthropic:anthropic');
      expect(p).not.toBeNull();
      expect(p!.input_per_1m_usd).toBe(3.0);
    });

    it('prefers longer composite prefix over shorter', () => {
      const svc = freshService();
      const p = svc.pricingFor('claude-sonnet-4-7-v2', 'anthropic:anthropic');
      expect(p).not.toBeNull();
      expect(p!.input_per_1m_usd).toBe(3.0);
    });

    it('matches bare model name via composite suffix when no provider given', () => {
      const svc = freshService();
      const p = svc.pricingFor('gpt-4o');
      expect(p).not.toBeNull();
      expect(p!.input_per_1m_usd).toBe(2.5);
    });

    it('matches local LM Studio model via suffix without provider', () => {
      const svc = freshService();
      // This is the exact flow used by the coordinator when a runner
      // reports { model: "google/gemma-4-26b-a4b-qat", tokens } with no provider.
      const p = svc.pricingFor('google/gemma-4-26b-a4b-qat');
      expect(p).not.toBeNull();
      expect(p!.input_per_1m_usd).toBe(0);
      expect(p!.output_per_1m_usd).toBe(0);
    });

    it('estimateUsd works with just model (no provider) for known local model', () => {
      const svc = freshService();
      const est = svc.estimateUsd(1_000_000, 500_000, 'google/gemma-4-26b-a4b-qat');
      expect(est.known).toBe(true);
      expect(est.usd).toBe(0); // local = free
    });

    it('estimateUsd returns known=false for unknown model without provider', () => {
      const svc = freshService();
      const est = svc.estimateUsd(1_000_000, 500_000, 'bogus-model-name');
      expect(est.known).toBe(false);
      expect(est.usd).toBe(0);
    });

    it('returns null when mismatching provider gives wrong composite', () => {
      const svc = freshService();
      const p = svc.pricingFor('claude-sonnet-4-7', 'openai:openai');
      expect(p).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // estimateUsd
  // ────────────────────────────────────────────────────────────────

  describe('estimateUsd', () => {
    it('returns 0 / not-known for null model', () => {
      const svc = freshService();
      const est = svc.estimateUsd(1_000_000, 500_000, null);
      expect(est.usd).toBe(0);
      expect(est.known).toBe(false);
      expect(est.updated_at).toBeNull();
    });

    it('returns 0 / not-known for unknown model', () => {
      const svc = freshService();
      const est = svc.estimateUsd(1_000_000, 500_000, 'bogus');
      expect(est.usd).toBe(0);
      expect(est.known).toBe(false);
    });

    it('calculates USD correctly for OpenAI', () => {
      const svc = freshService();
      const est = svc.estimateUsd(1_000_000, 500_000, 'gpt-4o', 'openai:openai');
      expect(est.usd).toBeCloseTo(7.5, 5);
      expect(est.known).toBe(true);
      expect(est.updated_at).toBe('2026-04-15');
    });

    it('calculates USD correctly for DeepSeek first-party', () => {
      const svc = freshService();
      const est = svc.estimateUsd(2_000_000, 1_000_000, 'deepseek-v4-flash', 'deepseek:deepseek');
      expect(est.usd).toBeCloseTo(0.90, 5);
      expect(est.known).toBe(true);
    });

    it('calculates USD correctly for llmapi gateway (markup)', () => {
      const svc = freshService();
      const est = svc.estimateUsd(2_000_000, 1_000_000, 'deepseek-v4-flash', 'llmapi:deepseek');
      expect(est.usd).toBeCloseTo(1.20, 5);
      expect(est.known).toBe(true);
    });

    it('calculates zero for local/free models', () => {
      const svc = freshService();
      const est = svc.estimateUsd(10_000_000, 5_000_000, 'qwen3', 'ollama:ollama');
      expect(est.usd).toBe(0);
      expect(est.known).toBe(true);
    });

    it('includes updated_at in response', () => {
      const svc = freshService();
      const est = svc.estimateUsd(100, 100, 'deepseek-v4-flash', 'deepseek:deepseek');
      expect(est.updated_at).toBe('2026-06-04');
    });

    it('returns known=false when provider mismatches model', () => {
      const svc = freshService();
      const est = svc.estimateUsd(1_000_000, 500_000, 'gpt-4o', 'deepseek:deepseek');
      expect(est.known).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // mergeTable
  // ────────────────────────────────────────────────────────────────

  describe('mergeTable', () => {
    it('populates defaults on init', () => {
      const svc = freshService();
      const table = getTable(svc);
      expect(Object.keys(table).length).toBe(DEFAULT_ENTRY_COUNT);
      expect(table['anthropic:anthropic:claude-sonnet-4-7']).toBeDefined();
      expect(table['deepseek:deepseek:deepseek-v4-flash']).toBeDefined();
      expect(table['llmapi:deepseek:deepseek-v4-flash']).toBeDefined();
      expect(table['ollama:ollama:qwen3']).toBeDefined();
    });

    it('overrides from OASIS_MODEL_PRICING_JSON env', () => {
      process.env.OASIS_MODEL_PRICING_JSON = JSON.stringify({
        'anthropic:anthropic:claude-sonnet-4-7': { input_per_1m_usd: 3.5, output_per_1m_usd: 17.5, updated: '2026-09-01' },
      });
      const svc = freshService();
      mergeTable(svc);
      const p = svc.pricingFor('claude-sonnet-4-7', 'anthropic:anthropic');
      expect(p!.input_per_1m_usd).toBe(3.5);
      expect(p!.output_per_1m_usd).toBe(17.5);
    });

    it('adds new entries from env override', () => {
      process.env.OASIS_MODEL_PRICING_JSON = JSON.stringify({
        'custom:custom:my-model': { input_per_1m_usd: 1.23, output_per_1m_usd: 4.56, updated: '2026-10-01' },
      });
      const svc = freshService();
      mergeTable(svc);
      const p = svc.pricingFor('my-model', 'custom:custom');
      expect(p!.input_per_1m_usd).toBe(1.23);
    });

    it('handles malformed env JSON gracefully', () => {
      process.env.OASIS_MODEL_PRICING_JSON = 'not-json';
      const svc = freshService();
      mergeTable(svc);
      expect(getTable(svc)['anthropic:anthropic:claude-sonnet-4-7']).toBeDefined();
    });

    it('applies API overrides on top of defaults + env', () => {
      process.env.OASIS_MODEL_PRICING_JSON = JSON.stringify({
        'anthropic:anthropic:claude-sonnet-4-7': { input_per_1m_usd: 3.5, output_per_1m_usd: 17.5, updated: '2026-09-01' },
      });
      const svc = freshService();
      mergeTable(svc, {
        'anthropic:anthropic:claude-sonnet-4-7': { input_per_1m_usd: 5.0, output_per_1m_usd: 25.0, updated: '2026-10-01' },
      });
      const p = svc.pricingFor('claude-sonnet-4-7', 'anthropic:anthropic');
      expect(p!.input_per_1m_usd).toBe(5.0);
      expect(p!.output_per_1m_usd).toBe(25.0);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // getTable / getTableSnapshot
  // ────────────────────────────────────────────────────────────────

  describe('getTable / getTableSnapshot', () => {
    it('getTable returns the internal table', () => {
      const svc = freshService();
      const table = svc.getTable();
      expect(table).toEqual(getTable(svc));
    });

    it('getTableSnapshot returns metadata', () => {
      const svc = freshService();
      const snap = svc.getTableSnapshot();
      expect(snap.entry_count).toBe(DEFAULT_ENTRY_COUNT);
      expect(snap.entries).toBeDefined();
      expect(snap.last_api_fetch).toBeNull();
      expect(snap.last_api_error).toBeNull();
      expect(snap.api_url).toBe('');
      expect(snap.refresh_interval_ms).toBe(3600000);
    });

    it('getTableSnapshot reflects fetch state when set', () => {
      const svc = freshService();
      (svc as any).lastApiFetch = '2026-06-10T12:00:00Z';
      (svc as any).fetchError = null;
      const snap = svc.getTableSnapshot();
      expect(snap.last_api_fetch).toBe('2026-06-10T12:00:00Z');
      expect(snap.last_api_error).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // fetchFromApi
  // ────────────────────────────────────────────────────────────────

  describe('fetchFromApi', () => {
    it('is no-op when apiUrl is empty', async () => {
      const { svc, mockGet } = svcWithMockedHttp();
      await svc.fetchFromApi();
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('handles API returning valid data', async () => {
      const { svc, mockGet } = svcWithMockedHttp();
      (svc as any).apiUrl = 'http://fake/api';

      mockGet.mockResolvedValue({
        data: {
          'test:test:my-model': { input_per_1m_usd: 0.5, output_per_1m_usd: 1.0, updated: '2026-12-01' },
          'test:test:other': { input_per_1m_usd: 1.0, output_per_1m_usd: 2.0 },
        },
      });

      await svc.fetchFromApi();

      expect(mockGet).toHaveBeenCalledTimes(1);
      const p = svc.pricingFor('my-model', 'test:test');
      expect(p).not.toBeNull();
      expect(p!.input_per_1m_usd).toBe(0.5);
      expect(p!.output_per_1m_usd).toBe(1.0);
      expect(p!.updated).toBe('2026-12-01');

      const p2 = svc.pricingFor('other', 'test:test');
      expect(p2!.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('skips invalid API entries', async () => {
      const { svc, mockGet } = svcWithMockedHttp();
      (svc as any).apiUrl = 'http://fake/api';

      mockGet.mockResolvedValue({
        data: {
          'good:good:valid': { input_per_1m_usd: 1, output_per_1m_usd: 2 },
          'bad:bad:invalid1': { input_per_1m_usd: 'not-a-number', output_per_1m_usd: 2 },
          'bad:bad:invalid2': { input_per_1m_usd: Infinity, output_per_1m_usd: 2 },
          'bad:bad:invalid3': null,
          'bad:bad:invalid4': { input_per_1m_usd: 1, output_per_1m_usd: undefined },
        },
      });

      await svc.fetchFromApi();

      expect(svc.pricingFor('valid', 'good:good')).not.toBeNull();
      expect(svc.pricingFor('invalid1', 'bad:bad')).toBeNull();
      expect(svc.pricingFor('invalid2', 'bad:bad')).toBeNull();
      expect(svc.pricingFor('invalid3', 'bad:bad')).toBeNull();
      expect(svc.pricingFor('invalid4', 'bad:bad')).toBeNull();
    });

    it('handles API returning non-object gracefully', async () => {
      const { svc, mockGet } = svcWithMockedHttp();
      (svc as any).apiUrl = 'http://fake/api';

      mockGet.mockResolvedValue({ data: 'just a string' });

      await expect(svc.fetchFromApi()).resolves.toBeUndefined();
      expect((svc as any).fetchError).toContain('non-object');
    });

    it('handles network errors gracefully', async () => {
      const { svc, mockGet } = svcWithMockedHttp();
      (svc as any).apiUrl = 'http://fake/api';

      mockGet.mockRejectedValue(new Error('ECONNREFUSED'));

      await svc.fetchFromApi();

      expect((svc as any).fetchError).toBe('ECONNREFUSED');
      const p = svc.pricingFor('deepseek-v4-flash', 'deepseek:deepseek');
      expect(p!.input_per_1m_usd).toBe(0.15);
    });

    it('sets lastApiFetch on success', async () => {
      const { svc, mockGet } = svcWithMockedHttp();
      (svc as any).apiUrl = 'http://fake/api';

      mockGet.mockResolvedValue({
        data: { 'a:b:c': { input_per_1m_usd: 1, output_per_1m_usd: 2 } },
      });

      const before = (svc as any).lastApiFetch;

      await svc.fetchFromApi();
      expect((svc as any).lastApiFetch).not.toBeNull();
      expect((svc as any).lastApiFetch).not.toBe(before);
      expect((svc as any).fetchError).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Edge cases
  // ────────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('empty input tokens yields zero cost', () => {
      const svc = freshService();
      const est = svc.estimateUsd(0, 0, 'gpt-4o', 'openai:openai');
      expect(est.usd).toBe(0);
      expect(est.known).toBe(true);
    });

    it('partial token counts work correctly', () => {
      const svc = freshService();
      const est = svc.estimateUsd(500, 200, 'claude-opus-4-7', 'anthropic:anthropic');
      expect(est.usd).toBeCloseTo(0.0225, 6);
    });

    it('same model different provider gives different price', () => {
      const svc = freshService();
      const estDs = svc.estimateUsd(1_000_000, 500_000, 'deepseek-v4-flash', 'deepseek:deepseek');
      const estLl = svc.estimateUsd(1_000_000, 500_000, 'deepseek-v4-flash', 'llmapi:deepseek');
      expect(estLl.usd).toBeGreaterThan(estDs.usd);
    });

    it('prefix match works for date-tagged model variants', () => {
      const svc = freshService();
      const p = svc.pricingFor('gpt-4o-2026-05-15', 'openai:openai');
      expect(p).not.toBeNull();
      expect(p!.input_per_1m_usd).toBe(2.5);
    });
  });
});
