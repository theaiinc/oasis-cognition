import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface ProjectContext {
  project_id?: string;
  project_path?: string;
  session_id?: string;
  interaction_id?: string;
  user_id?: string;
}

/**
 * Request-scoped project context without mutating process-global workspace state.
 * AsyncLocalStorage preserves isolation when multiple interactions execute concurrently.
 */
@Injectable()
export class ProjectContextService {
  private readonly storage = new AsyncLocalStorage<ProjectContext>();

  get(): ProjectContext | undefined {
    return this.storage.getStore();
  }

  run<T>(context: ProjectContext, callback: () => T): T {
    return this.storage.run({ ...context }, callback);
  }
}
