/**
 * PricingController — exposes the pricing table for inspection and manual refresh.
 *
 * GET  /api/v1/pricing        → full table snapshot
 * POST /api/v1/pricing/refresh → trigger an API re-fetch (only if OASIS_PRICING_API_URL is set)
 */

import { Controller, Get, Post, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { PricingService } from './pricing.service';

@Controller('pricing')
export class PricingController {
  private readonly logger = new Logger(PricingController.name);

  constructor(private readonly pricing: PricingService) {}

  @Get()
  getPricing() {
    return this.pricing.getTableSnapshot();
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refreshPricing() {
    if (!process.env.OASIS_PRICING_API_URL) {
      return { ok: false, error: 'OASIS_PRICING_API_URL is not set — no remote pricing source configured' };
    }
    await this.pricing.fetchFromApi();
    return {
      ok: true,
      entry_count: Object.keys(this.pricing.getTable()).length,
      last_api_fetch: (await this.pricing.getTableSnapshot()).last_api_fetch,
    };
  }
}
