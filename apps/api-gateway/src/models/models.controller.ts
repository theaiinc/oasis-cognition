/**
 * ModelsController — exposes the model variant registry for admin / debug.
 *
 * GET /api/v1/models        → list all known model variants
 * GET /api/v1/models/lookup?model=...&provider=... → look up a single variant
 */
import { Controller, Get, Query, Logger } from '@nestjs/common';
import { listVariants, lookupVariant } from '../models/model-variants';

@Controller('models')
export class ModelsController {
  private readonly logger = new Logger(ModelsController.name);

  @Get()
  list() {
    return listVariants();
  }

  @Get('lookup')
  lookup(
    @Query('model') model?: string,
    @Query('provider') provider?: string,
  ) {
    const v = lookupVariant(provider, model);
    if (!v) return { found: false, model, provider };
    return { found: true, variant: v };
  }
}
