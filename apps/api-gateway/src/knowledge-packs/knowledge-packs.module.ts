import { Module } from '@nestjs/common';
import { KnowledgePacksController } from './knowledge-packs.controller';
import { KnowledgePacksService } from './knowledge-packs.service';

@Module({
  controllers: [KnowledgePacksController],
  providers: [KnowledgePacksService],
})
export class KnowledgePacksModule {}
