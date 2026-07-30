import { Injectable, Optional } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ArcanaCommand {
  projectDir: string;
  executable: string;
  args?: string[];
}

export interface ArcanaHealth {
  configured: boolean;
  available: boolean;
  status: 'disabled' | 'ready' | 'unavailable';
  error?: string;
}

export interface ArcanaRunner {
  run(args: string[]): Promise<{ stdout: string; stderr: string }>;
}

class AshRunner implements ArcanaRunner {
  constructor(private readonly executable: string) {}

  async run(args: string[]) {
    return execFileAsync(this.executable, args, {
      timeout: Number(process.env.ARCANA_COMMAND_TIMEOUT_MS || 15_000),
      maxBuffer: 256 * 1024,
    });
  }
}

@Injectable()
export class ArcanaService {
  private readonly enabled = process.env.ARCANA_ENABLED === 'true';
  private readonly ashPath = process.env.ARCANA_ASH_PATH || 'ash';
  private readonly runner: ArcanaRunner;

  constructor(@Optional() runner?: ArcanaRunner) {
    this.runner = runner || new AshRunner(this.ashPath);
  }

  async health(): Promise<ArcanaHealth> {
    if (!this.enabled) {
      return { configured: false, available: false, status: 'disabled' };
    }
    try {
      await this.runner.run(['--help']);
      return { configured: true, available: true, status: 'ready' };
    } catch (err: any) {
      return {
        configured: true,
        available: false,
        status: 'unavailable',
        error: err?.code || err?.message || 'ash unavailable',
      };
    }
  }

  async runProjectCommand(command: ArcanaCommand): Promise<{ stdout: string; stderr: string }> {
    if (!this.enabled) throw new Error('Arcana integration is disabled');
    if (!command.projectDir.startsWith('/')) throw new Error('projectDir must be an absolute path');
    if (!command.executable.startsWith('/')) throw new Error('executable must be an absolute path');
    const args = command.args || [];
    if ([command.projectDir, command.executable, ...args].some(value => value.includes('\u0000'))) {
      throw new Error('command contains a NUL byte');
    }

    // Fixed argv only: no shell, no secret values, and no caller-supplied
    // policy/secret references. Arcana resolves the project policy itself.
    return this.runner.run([
      '--project-dir',
      command.projectDir,
      '--',
      command.executable,
      ...args,
    ]);
  }
}
