import { ArcanaService, type ArcanaRunner } from './arcana.service';

describe('ArcanaService', () => {
  const originalEnabled = process.env.ARCANA_ENABLED;

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.ARCANA_ENABLED;
    else process.env.ARCANA_ENABLED = originalEnabled;
  });

  it('is disabled by default', async () => {
    delete process.env.ARCANA_ENABLED;
    const runner: ArcanaRunner = { run: jest.fn() };
    const service = new ArcanaService(runner);

    await expect(service.health()).resolves.toEqual({
      configured: false,
      available: false,
      status: 'disabled',
    });
    await expect(service.runProjectCommand({
      projectDir: '/tmp/project',
      executable: '/bin/true',
    })).rejects.toThrow('disabled');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('reports an unavailable Ash adapter without throwing from health', async () => {
    process.env.ARCANA_ENABLED = 'true';
    const runner: ArcanaRunner = {
      run: jest.fn().mockRejectedValue({ code: 'ECONNREFUSED' }),
    };
    const service = new ArcanaService(runner);

    await expect(service.health()).resolves.toEqual({
      configured: true,
      available: false,
      status: 'unavailable',
      error: 'ECONNREFUSED',
    });
  });

  it('uses fixed argv and does not accept secret values', async () => {
    process.env.ARCANA_ENABLED = 'true';
    const run = jest.fn().mockResolvedValue({ stdout: 'ok\n', stderr: '' });
    const runner: ArcanaRunner = { run };
    const service = new ArcanaService(runner);

    await expect(service.runProjectCommand({
      projectDir: '/tmp/project',
      executable: '/usr/bin/gh',
      args: ['issue', 'list'],
    })).resolves.toEqual({ stdout: 'ok\n', stderr: '' });
    expect(runner.run).toHaveBeenCalledWith([
      '--project-dir', '/tmp/project', '--', '/usr/bin/gh', 'issue', 'list',
    ]);
    expect(JSON.stringify(run.mock.calls)).not.toContain('secret-value');
  });

  it('rejects non-absolute paths and NUL bytes before invoking Ash', async () => {
    process.env.ARCANA_ENABLED = 'true';
    const runner: ArcanaRunner = { run: jest.fn() };
    const service = new ArcanaService(runner);

    await expect(service.runProjectCommand({
      projectDir: 'relative',
      executable: '/bin/true',
    })).rejects.toThrow('absolute path');
    await expect(service.runProjectCommand({
      projectDir: '/tmp/project',
      executable: '/bin/true',
      args: ['bad\u0000arg'],
    })).rejects.toThrow('NUL');
    expect(runner.run).not.toHaveBeenCalled();
  });
});
