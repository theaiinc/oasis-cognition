import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Langfuse } from 'langfuse';

const LANGFUSE_ENABLED = (process.env.LANGFUSE_ENABLED || 'true') === 'true';
const LANGFUSE_HOST = process.env.LANGFUSE_HOST || 'http://localhost:3100';
const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || '';
const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || '';

@Injectable()
export class LangfuseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LangfuseService.name);
  private client: Langfuse | null = null;

  onModuleInit() {
    if (!LANGFUSE_ENABLED) {
      this.logger.log('Langfuse tracing disabled');
      return;
    }
    try {
      this.client = new Langfuse({
        publicKey: LANGFUSE_PUBLIC_KEY,
        secretKey: LANGFUSE_SECRET_KEY,
        baseUrl: LANGFUSE_HOST,
      });
      this.logger.log(`Langfuse tracing enabled → ${LANGFUSE_HOST}`);
    } catch (err: any) {
      this.logger.warn(`Failed to init Langfuse: ${err.message}`);
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.shutdownAsync();
    }
  }

  createTrace(params: { name: string; sessionId: string; input?: any; metadata?: Record<string, any> }) {
    if (!this.client) return null;
    return this.client.trace({
      name: params.name,
      sessionId: params.sessionId,
      input: params.input,
      metadata: params.metadata,
    });
  }
}
