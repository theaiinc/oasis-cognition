import { Module } from '@nestjs/common';
import { WebSearchController } from './web-search.controller';

@Module({
  controllers: [WebSearchController],
})
export class WebSearchModule {}
