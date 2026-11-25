import {
  MAX_SELF_VALIDATION_NUDGES, discoverChecks, exerciseOf, isSourceFile, selfValidationGate, selfValidationNote, selfValidationState,
  type SelfValidationResult,
} from './self-validation';

const WT = 'wt-1';
const edit = (path: string, over: Partial<SelfValidationResult> = {}): SelfValidationResult => ({ tool: 'edit_file', success: true, path, worktree_id: WT, output: 'edited', ...over });
const bash = (command: string, success: boolean, output = '', over: Partial<SelfValidationResult> = {}): SelfValidationResult => ({ tool: 'bash', success, command, output, worktree_id: WT, ...over });
const read = (path: string): SelfValidationResult => ({ tool: 'read_worktree_file', success: true, path, output: '...' });

const JEST_FAIL = (names: string[]) => `FAIL src/a.spec.ts\n${names.map((n) => `  ● ${n}`).join('\n')}\nTests: ${names.length} failed, 3 passed`;

describe('when the self-check fires', () => {
  it('fires when source was edited and nothing ran after the last edit', () => {
    const state = selfValidationState([read('src/a.ts'), edit('src/a.ts'), { tool: 'get_diff', success: true, output: 'diff' }], WT);
    expect(state.status).toBe('not-run');
    expect(state.edited).toEqual(['src/a.ts']);
    expect(selfValidationGate(state, 0, 20)).toEqual({ hold: true });
  });

  it('fires when the only run came before the last edit', () => {
    const state = selfValidationState([edit('src/a.ts'), bash('npx jest src/a', true, 'Tests: 4 passed'), edit('src/a.ts')], WT);
    expect(state.status).toBe('not-run');
  });

  it('does not fire on a turn with no source edits', () => {
    expect(selfValidationState([read('src/a.ts'), bash('git status', true)], WT).status).toBe('no-edits');
    // Docs, config and data are not source.
    const docs = selfValidationState([edit('README.md'), edit('docs/guide.md'), edit('config/app.json'), edit('.github/workflows/ci.yml')], WT);
    expect(docs.status).toBe('no-edits');
    expect(selfValidationGate(docs, 0, 20)).toEqual({ hold: false, why: 'no-edits' });
    // A failed or blocked edit changed nothing.
    expect(selfValidationState([edit('src/a.ts', { success: false }), edit('src/b.ts', { blocked: true })], WT).status).toBe('no-edits');
  });

  it('does not fire once a test, typecheck, reproduction or browser look passed after the last edit', () => {
    for (const run of [
      bash('cd apps/web && npx jest src/a.spec.ts 2>&1 | tail -40', true, 'Tests: 4 passed'),
      bash('npx tsc --noEmit', true),
      bash('python -m pytest -q tests/test_a.py', true, '3 passed'),
      bash('python -c "from pkg.a import f; print(f(2))"', true, '4'),
      bash('node scripts/repro.js', true, 'ok'),
      bash('curl -s localhost:3000/api/health', true, '{"ok":true}'),
      { tool: 'browser_screenshot', success: true, output: 'screenshot' },
    ]) {
      const state = selfValidationState([edit('src/a.ts'), run], WT);
      expect(state.status).toBe('passed');
      expect(selfValidationGate(state, 0, 20)).toEqual({ hold: false, why: 'exercised' });
    }
  });

  it('does not count commands that exercise nothing', () => {
    for (const cmd of ['git diff', 'cat src/a.ts', 'grep -rn foo src', 'npm install', 'npm run dev', 'ls', 'python -m pip install x']) {
      expect(exerciseOf(cmd)).toBeNull();
      expect(selfValidationState([edit('src/a.ts'), bash(cmd, true)], WT).status).toBe('not-run');
    }
  });

  it('does not count a run in another worktree', () => {
    const state = selfValidationState([edit('src/a.ts'), bash('npx jest src/a', true, 'Tests: 1 passed', { worktree_id: 'other-wt' })], WT);
    expect(state.status).toBe('not-run');
  });

  it('sends a failure back with what failed, so the turn fixes and reruns', () => {
    const results = [edit('src/a.ts'), bash('npx jest src/a', false, JEST_FAIL(['adds › two numbers']))];
    const state = selfValidationState(results, WT);
    expect(state.status).toBe('failed');
    expect(state.failed?.failures).toEqual(['adds › two numbers']);
    expect(selfValidationGate(state, 0, 20)).toEqual({ hold: true });
    const note = selfValidationNote(state, [], 1);
    expect(note).toContain('adds › two numbers');
    expect(note).toContain('fix it, and run the same check again');
    // Fixed and rerun: the latest run of that check decides.
    const fixed = selfValidationState([...results, edit('src/a.ts'), bash('npx jest src/a', true, 'Tests: 4 passed')], WT);
    expect(fixed.status).toBe('passed');
  });

  it('a pass of one check does not hide a new failure of another', () => {
    const state = selfValidationState([edit('src/a.ts'), bash('npx tsc --noEmit', true), bash('npx jest src/a', false, JEST_FAIL(['adds › two numbers']))], WT);
    expect(state.status).toBe('failed');
  });

  it('a run that never started (missing script, command not found) is not a check', () => {
    const state = selfValidationState([edit('src/a.ts'), bash('pnpm test', false, 'sh: pnpm: command not found')], WT);
    expect(state.status).toBe('not-started');
    expect(selfValidationGate(state, 0, 20).hold).toBe(true);
    expect(selfValidationNote(state, [], 1)).toContain('did not run');
  });

  it('a background run is judged when its job reports back', () => {
    const started = bash('npx jest', true, 'Started background job j-9', { background: true, job_id: 'j-9' });
    expect(selfValidationState([edit('src/a.ts'), started], WT).status).toBe('pending');
    const passed = { tool: 'wait_for', success: true, output: 'Job j-9 already exited with code 0; no need to wait.' };
    expect(selfValidationState([edit('src/a.ts'), started, passed], WT).status).toBe('passed');
    const failed = { tool: 'job_status', success: true, output: `job j-9 exited with code 1\n${JEST_FAIL(['x › y'])}` };
    expect(selfValidationState([edit('src/a.ts'), started, failed], WT).status).toBe('failed');
  });
});

describe('pre-existing failures do not count', () => {
  it('a failure the same check already had before the first edit is left out', () => {
    const before = bash('npx jest', false, JEST_FAIL(['edge › renders the legacy banner']));
    const after = bash('npx jest', false, JEST_FAIL(['edge › renders the legacy banner']));
    const state = selfValidationState([before, edit('src/a.ts'), after], WT);
    expect(state.status).toBe('pre-existing');
    expect(state.preExisting).toEqual(['edge › renders the legacy banner']);
    expect(selfValidationGate(state, 0, 20)).toEqual({ hold: false, why: 'exercised' });
  });

  it('a new failure next to a pre-existing one still counts, and only the new one is reported', () => {
    const before = bash('npx jest', false, JEST_FAIL(['edge › renders the legacy banner']));
    const after = bash('npx jest', false, JEST_FAIL(['edge › renders the legacy banner', 'adds › two numbers']));
    const state = selfValidationState([before, edit('src/a.ts'), after], WT);
    expect(state.status).toBe('failed');
    expect(state.failed?.failures).toEqual(['adds › two numbers']);
  });

  it('a pre-existing failure that names a changed file still counts (the fix did not work)', () => {
    const tsc = (out: string) => bash('npx tsc --noEmit', false, out);
    const err = 'src/parser.ts(10,3): error TS2322: Type string is not assignable to type number.';
    const state = selfValidationState([tsc(err), edit('src/parser.ts'), tsc(err)], WT);
    expect(state.status).toBe('failed');
  });

  it('a reproduction that fails the same way after the edit still counts', () => {
    const repro = () => bash('python repro.py', false, 'AssertionError: expected 4, got 5');
    expect(selfValidationState([repro(), edit('pkg/calc.py'), repro()], WT).status).toBe('failed');
  });

  it('a failure of a different check before the edit is no baseline', () => {
    const state = selfValidationState([bash('npx tsc --noEmit', false, 'error TS1005: x'), edit('src/a.ts'), bash('npx jest', false, JEST_FAIL(['a › b']))], WT);
    expect(state.status).toBe('failed');
  });
});

describe('the bound', () => {
  const unexercised = selfValidationState([edit('src/a.ts')], WT);

  it(`sends a turn back at most ${MAX_SELF_VALIDATION_NUDGES} times`, () => {
    for (let n = 0; n < MAX_SELF_VALIDATION_NUDGES; n++) expect(selfValidationGate(unexercised, n, 20)).toEqual({ hold: true });
    expect(selfValidationGate(unexercised, MAX_SELF_VALIDATION_NUDGES, 20)).toEqual({ hold: false, why: 'bound' });
    expect(selfValidationGate(unexercised, MAX_SELF_VALIDATION_NUDGES + 5, 20)).toEqual({ hold: false, why: 'bound' });
  });

  it('lets the turn end when there are not enough steps left to run anything', () => {
    expect(selfValidationGate(unexercised, 0, 2)).toEqual({ hold: false, why: 'no-room' });
  });

  it('a check that keeps failing stops holding the turn at the bound', () => {
    const failing = selfValidationState([edit('src/a.ts'), bash('npx jest', false, JEST_FAIL(['a › b']))], WT);
    expect(selfValidationGate(failing, MAX_SELF_VALIDATION_NUDGES, 20).hold).toBe(false);
  });

  it('the note says which self-check this is', () => {
    expect(selfValidationNote(unexercised, [], 2)).toContain(`Self-check 2 of ${MAX_SELF_VALIDATION_NUDGES}`);
  });
});

describe("the project's own checks", () => {
  const repo = (files: Record<string, string>) => {
    const reads: string[] = [];
    const reader = async (p: string) => {
      reads.push(p);
      return p in files ? files[p] : null;
    };
    return { reader, reads };
  };

  it('reads the nearest package.json scripts and the package manager its lockfile names', async () => {
    const { reader } = repo({
      'package.json': JSON.stringify({ private: true, workspaces: ['apps/*'] }),
      'pnpm-lock.yaml': 'lockfileVersion: 9',
      'apps/web/package.json': JSON.stringify({ scripts: { test: 'jest', typecheck: 'tsc --noEmit', lint: 'eslint .', dev: 'next dev' } }),
    });
    const checks = await discoverChecks(reader, ['apps/web/src/lib/a.ts']);
    expect(checks.map((c) => c.command)).toEqual([
      'cd apps/web && npx jest src/lib/a',
      'cd apps/web && npx pnpm test',
      'cd apps/web && npx pnpm run typecheck',
      'cd apps/web && npx pnpm run lint',
    ]);
    expect(checks[1].from).toBe('apps/web/package.json scripts.test');
  });

  it('uses the version packageManager declares', async () => {
    const { reader } = repo({ 'package.json': JSON.stringify({ packageManager: 'pnpm@9.12.0', scripts: { test: 'vitest' } }) });
    const checks = await discoverChecks(reader, ['src/a.ts']);
    expect(checks.map((c) => c.command)).toEqual(['npx vitest run src/a', 'npx pnpm@9 test']);
  });

  it('skips npm init placeholder test scripts', async () => {
    const { reader } = repo({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
    expect(await discoverChecks(reader, ['index.js'])).toEqual([]);
  });

  it('reads pytest, ruff and mypy config for Python edits', async () => {
    const { reader } = repo({ 'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n[tool.ruff]\nline-length = 100\n' });
    const checks = await discoverChecks(reader, ['pkg/parser.py']);
    expect(checks.map((c) => c.command)).toEqual(['python -m pytest -q -k "parser"', 'python -m pytest -q', 'ruff check pkg/parser.py']);
  });

  it('reads Makefile targets, go.mod and Cargo.toml', async () => {
    const { reader } = repo({ Makefile: 'build:\n\tgo build ./...\ntest:\n\tgo test ./...\n', 'go.mod': 'module x', 'Cargo.toml': '[package]' });
    const checks = await discoverChecks(reader, ['internal/db/q.go', 'src/lib.rs']);
    expect(checks.map((c) => c.command)).toEqual(['go test ./internal/db/...', 'cargo test', 'make test']);
  });

  it('guesses nothing for a repo with no check config', async () => {
    const { reader, reads } = repo({});
    expect(await discoverChecks(reader, ['src/a.ts'])).toEqual([]);
    expect(reads.length).toBeLessThanOrEqual(16);
    const note = selfValidationNote(selfValidationState([edit('src/a.ts')], WT), [], 1);
    expect(note).toContain('No test, lint or typecheck script was found');
    expect(note).not.toContain('npm test');
  });

  it('a read that throws is a missing file', async () => {
    const checks = await discoverChecks(async () => {
      throw new Error('dev-agent down');
    }, ['src/a.ts']);
    expect(checks).toEqual([]);
  });

  it('the note lists what was found', () => {
    const note = selfValidationNote(selfValidationState([edit('src/a.ts')], WT), [{ command: 'npm test', from: 'package.json scripts.test' }], 1);
    expect(note).toContain('`npm test` (from package.json scripts.test)');
    expect(note).toContain('nothing has run since your last edit');
  });
});

describe('source files', () => {
  it.each(['src/a.ts', 'app/page.tsx', 'pkg/mod.py', 'cmd/main.go', 'src/lib.rs', 'styles/site.css', 'lib/x.rb'])('%s is source', (p) => {
    expect(isSourceFile(p)).toBe(true);
  });
  it.each(['README.md', 'package.json', 'config.yaml', 'dist/bundle.js', 'node_modules/x/index.js', 'public/app.min.js', 'notes.txt'])('%s is not', (p) => {
    expect(isSourceFile(p)).toBe(false);
  });
});
