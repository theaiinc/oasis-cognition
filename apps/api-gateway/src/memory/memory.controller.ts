import { Controller, Get, Delete, Query, Body, Logger, HttpException, HttpStatus } from '@nestjs/common';
import axios from 'axios';

const MEMORY_URL = process.env.MEMORY_URL || 'http://localhost:8004';

@Controller('memory')
export class MemoryController {
  private readonly logger = new Logger(MemoryController.name);

  @Get('query')
  async queryMemory(
    @Query('q') q: string,
    @Query('limit') limit: string = '10',
  ) {
    if (!q) {
      throw new HttpException('Query parameter "q" is required', HttpStatus.BAD_REQUEST);
    }

    try {
      const res = await axios.get(`${MEMORY_URL}/internal/memory/query`, {
        params: { q, limit: parseInt(limit, 10) },
      });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Memory query failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('rules')
  async getRules() {
    try {
      const res = await axios.get(`${MEMORY_URL}/internal/memory/rules`);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Rules query failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('rules/graph')
  async getRulesGraph() {
    try {
      const res = await axios.get(`${MEMORY_URL}/internal/memory/rules/graph`);
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Rules graph query failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete('rules')
  async deleteRule(@Body() body: { rule_id: string }) {
    if (!body?.rule_id) {
      throw new HttpException('rule_id is required', HttpStatus.BAD_REQUEST);
    }
    try {
      const res = await axios.delete(`${MEMORY_URL}/internal/memory/rules`, { data: { rule_id: body.rule_id } });
      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Rule deletion failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
