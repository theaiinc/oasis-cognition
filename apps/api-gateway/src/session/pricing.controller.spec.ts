import { Test, TestingModule } from '@nestjs/testing';
import { PricingController } from './pricing.controller';
import { PricingService } from './pricing.service';

describe('PricingController', () => {
  let OENV: typeof process.env;

  beforeAll(() => { OENV = process.env; });

  beforeEach(() => {
    process.env = { ...OENV };
    delete process.env.OASIS_PRICING_API_URL;
    delete process.env.OASIS_MODEL_PRICING_JSON;
  });

  afterAll(() => { process.env = OENV; });

  async function buildModule(): Promise<TestingModule> {
    const module = await Test.createTestingModule({
      controllers: [PricingController],
      providers: [PricingService],
    }).compile();
    const svc = module.get<PricingService>(PricingService);
    (svc as any).mergeTable();
    return module;
  }

  describe('GET /pricing', () => {
    it('returns the table snapshot with entries', async () => {
      const module = await buildModule();
      const ctrl = module.get<PricingController>(PricingController);

      const result = ctrl.getPricing();
      expect(result).toHaveProperty('entries');
      expect(result).toHaveProperty('entry_count');
      expect(result).toHaveProperty('last_api_fetch');
      expect(result).toHaveProperty('last_api_error');
      expect(result).toHaveProperty('api_url');
      expect(result).toHaveProperty('refresh_interval_ms');
      expect(result.entry_count).toBeGreaterThan(0);
      expect(Object.keys(result.entries).length).toBe(result.entry_count);
    });
  });

  describe('POST /pricing/refresh', () => {
    it('returns error when OASIS_PRICING_API_URL is not set', async () => {
      const module = await buildModule();
      const ctrl = module.get<PricingController>(PricingController);

      const result = await ctrl.refreshPricing();
      expect(result).toEqual({
        ok: false,
        error: 'OASIS_PRICING_API_URL is not set — no remote pricing source configured',
      });
    });

    it('calls fetchFromApi and returns ok when API is configured', async () => {
      process.env.OASIS_PRICING_API_URL = 'http://mock/api';
      const module = await buildModule();
      const ctrl = module.get<PricingController>(PricingController);
      const svc = module.get<PricingService>(PricingService);

      (svc as any).http = { get: jest.fn().mockResolvedValue({ data: {} }) };

      const result = await ctrl.refreshPricing();
      expect(result.ok).toBe(true);
      expect(result.entry_count).toBeGreaterThan(0);
      expect(result).toHaveProperty('last_api_fetch');
    });
  });
});
