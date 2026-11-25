import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { KnowledgePacksService } from './knowledge-packs.service';

/**
 * /api/v1/knowledge-packs: download a project's rules as a versioned JSON pack, and
 * upload one to merge into a project.
 */
@Controller('knowledge-packs')
export class KnowledgePacksController {
  constructor(private readonly packs: KnowledgePacksService) {}

  @Get('export')
  export(@Query('project_id') projectId?: string, @Query('name') name?: string) {
    return this.packs.export(projectId || undefined, name);
  }

  @Post('import')
  import(@Body() body: any) {
    return this.packs.import(body || {});
  }
}
