import { lookupVariant, inferBillingClass, inferResourceClass, getContextLength, validateModelProvider, listVariants } from './model-variants';

describe('model-variants', () => {
  describe('lookupVariant', () => {
    it('returns null for empty input', () => {
      expect(lookupVariant(null, null)).toBeNull();
      expect(lookupVariant('openai', null)).toBeNull();
      expect(lookupVariant(null, '')).toBeNull();
    });

    it('finds LM Studio gemma-4-26b by exact match', () => {
      const v = lookupVariant('openai', 'google/gemma-4-26b-a4b-qat');
      expect(v).not.toBeNull();
      expect(v!.name).toContain('Gemma 4 26B');
      expect(v!.billing_class).toBe('free_local');
      expect(v!.resource_class).toBe('gpu');
      expect(v!.context_length).toBe(262_144);
    });

    it('finds LM Studio gemma-4-12b by prefix', () => {
      const v = lookupVariant('openai', 'google/gemma-4-12b');
      expect(v).not.toBeNull();
      expect(v!.name).toContain('12B');
    });

    it('finds deepseek-v3.2', () => {
      const v = lookupVariant('deepseek', 'deepseek-v3.2');
      expect(v).not.toBeNull();
      expect(v!.billing_class).toBe('paid_api');
    });

    it('finds nomic embedding model', () => {
      const v = lookupVariant('openai', 'text-embedding-nomic-embed-text-v1.5');
      expect(v).not.toBeNull();
      expect(v!.capabilities.embedding).toBe(true);
    });

    it('returns null for unknown model', () => {
      expect(lookupVariant(null, 'nonexistent-model-v9')).toBeNull();
    });
  });

  describe('inferBillingClass', () => {
    it('returns free_local for LM Studio models', () => {
      expect(inferBillingClass('openai', 'google/gemma-4-26b-a4b-qat')).toBe('free_local');
    });
    it('returns paid_api for deepseek models', () => {
      expect(inferBillingClass('deepseek', 'deepseek-v4-flash')).toBe('paid_api');
    });
    it('returns uncertain for unknown models', () => {
      expect(inferBillingClass('openai', 'bogus-model')).toBe('uncertain');
    });
  });

  describe('inferResourceClass', () => {
    it('returns gpu for 26b model', () => {
      expect(inferResourceClass('openai', 'google/gemma-4-26b-a4b-qat')).toBe('gpu');
    });
    it('returns standard for 12b model', () => {
      expect(inferResourceClass('openai', 'google/gemma-4-12b')).toBe('standard');
    });
  });

  describe('getContextLength', () => {
    it('returns 262k for gemma-4 models', () => {
      expect(getContextLength('openai', 'google/gemma-4-26b-a4b-qat')).toBe(262_144);
    });
    it('returns 128k for deepseek models', () => {
      expect(getContextLength('deepseek', 'deepseek-v4-flash')).toBe(128_000);
    });
    it('returns fallback for unknown models', () => {
      expect(getContextLength(null, 'random-model')).toBe(128_000);
    });
  });

  describe('validateModelProvider', () => {
    it('returns null for valid pair', () => {
      expect(validateModelProvider('openai', 'google/gemma-4-26b-a4b-qat')).toBeNull();
    });
    it('returns error for mismatched provider', () => {
      const err = validateModelProvider('ollama', 'google/gemma-4-26b-a4b-qat');
      expect(err).toContain('expects provider "openai"');
    });
    it('returns null for unknown model (cannot validate)', () => {
      expect(validateModelProvider('openai', 'bogus-model')).toBeNull();
    });
  });

  describe('listVariants', () => {
    it('returns all registered variants', () => {
      const all = listVariants();
      expect(all.length).toBeGreaterThanOrEqual(6);  // 3 gemma-4 + qwen3 + 2 deepseek + nomic + qwen-vision
      const names = all.map(v => v.name);
      expect(names).toContain('Gemma 4 26B (4B active) QAT');
      expect(names).toContain('DeepSeek V4 Flash');
    });
  });
});
