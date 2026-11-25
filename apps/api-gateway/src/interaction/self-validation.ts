/**
 * A coding turn that changed source files runs something that exercises the change before it ends.
 *
 * A 50-task SWE-bench Verified run found the agent ran code to check its work on only 13 of 50
 * tasks. It often made the edit in the right file but too
 * small or in the wrong place, and finished without reproducing the bug or running a test. The
 * observer's goal check judges what the turn claims; it never
 * asks whether anything ran after the last edit.
 *
 * So when the goal check passes on a turn whose results include a source edit, the results after the
 * last source edit must hold a run in the chat's worktree that exercises it: a test, typecheck or lint
 * run (verification-commands.ts verificationTarget), a reproduction (a script, `python -c`, `node -e`, a
 * curl to a local server) or a look in the chat's browser. If not, the turn is sent back with the
 * project's own check commands, read from its package.json scripts, pytest config, Makefile, go.mod or
 * Cargo.toml (never guessed), at most MAX_SELF_VALIDATION_NUDGES times. A run that failed after the
 * edit sends the turn back with what failed, so it fixes and reruns. Failures the same test, typecheck
 * or lint run already showed before the turn's first edit don't count, unless they name a
 * file the turn changed; a reproduction that still fails does. Runs that never got going (command not
 * found, no such script) are not a check.
 */
import type { VerificationTarget } from './verification-commands';
import { commandSegments, failureSignature, sameCheck, verificationTarget, withoutWorktree } from './verification-commands';

/** Times one turn is sent back to exercise its change before it may end anyway. */
export const MAX_SELF_VALIDATION_NUDGES = 2;
/** Steps a send-back needs to be worth it (run, read the result, answer). */
const MIN_STEPS_LEFT = 3;

const EDIT_TOOLS = new Set(['edit_file', 'write_file', 'delete_file']);
/** Files whose change is code: docs, config and data are not. */
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|pyi|rs|go|rb|java|kts?|scala|swift|m|mm|c|cc|cpp|cxx|h|hh|hpp|cs|fs|php|vue|svelte|astro|ex|exs|erl|dart|lua|r|jl|zig|sh|bash|sql|html?|css|scss|sass|less)$/i;
/** The chat's browser, looking at a page: a check of a UI change. */
const LOOK_TOOLS = new Set(['browser_open', 'browser_read', 'browser_screenshot', 'browser_screenshots', 'browser_console', 'browser_eval', 'browser_click']);

/** A run that never got going: it says nothing about the change. */
const NOT_STARTED = /command not found|: not found\b|exited with code 127\b|Missing script|ERR_PNPM_NO_SCRIPT|Couldn't find a script named|Unknown command|No module named '?(?:pytest|mypy|ruff)\b|Cannot find module '[^']*(?:jest|vitest|ts-node|tsx)[^']*'/i;

/** Segments that run code the change touches (not a verification runner, which verificationTarget reads). */
const REPRO: RegExp[] = [
  /^python[\d.]*\s+(?!-m\s+(?:pip|venv|http\.server|ensurepip)\b)(?:-c\s|-m\s|\S+\.py\b)/,
  /^(?:node|tsx|ts-node|deno run|bun)\s+(?:-e\s|--eval\b|-p\s|\S+\.[cm]?[jt]sx?\b)/,
  /^(?:go run|cargo run|dotnet (?:run|test)|swift run|mvn (?:test|verify)|gradle(?:w)? test|\.\/gradlew test|rspec|bundle exec|phpunit)\b/,
  /^(?:ruby\s+\S+\.rb|php\s+\S+\.php|(?:ba|z)?sh\s+\S+\.sh)\b/,
  /^\.\/[\w./-]+/,
  /^curl\b.*\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])\b/,
  /^(?:npm|pnpm|yarn|bun) run (?!dev\b|start\b|serve\b|preview\b|watch\b)[\w:.-]+/,
];

export interface SelfValidationResult {
  tool?: string;
  success?: boolean;
  blocked?: boolean;
  command?: string;
  output?: string;
  path?: string;
  worktree_id?: string;
  background?: boolean;
  job_id?: string;
}

type RunOutcome = 'pass' | 'fail' | 'not-started' | 'pending';

interface Exercise {
  index: number;
  command: string;
  /** A test/typecheck/lint/build run; none for a reproduction or a browser look. */
  target: VerificationTarget | null;
  /** The command normalized, for reproductions. */
  key: string;
  outcome: RunOutcome;
  /** What a failed run hit (failureSignature items). */
  failures: string[];
}

export type SelfValidationStatus =
  /** No source file changed this turn. */
  | 'no-edits'
  /** Something ran after the last edit and passed. */
  | 'passed'
  /** It failed only on what it already failed on before the turn's first edit. */
  | 'pre-existing'
  /** A run after the last edit failed on something new. */
  | 'failed'
  /** Runs after the last edit never got going (command not found, no such script). */
  | 'not-started'
  /** A background run after the last edit has not reported yet. */
  | 'pending'
  /** Nothing ran after the last edit. */
  | 'not-run';

export interface SelfValidationState {
  status: SelfValidationStatus;
  /** Source files changed this turn, repo-relative. */
  edited: string[];
  /** For failed: the run and what it hit (new failures only). */
  failed?: { command: string; failures: string[] };
  /** For pre-existing: what was left out of the count. */
  preExisting?: string[];
  /** For not-started / pending: the command. */
  command?: string;
}

/** A path as the edit tools give it, repo-relative. */
export function repoPath(path: string): string {
  return withoutWorktree(path.trim()).replace(/^\/workspace\//, '').replace(/^\.\//, '').replace(/^\//, '');
}

export function isSourceFile(path: string | undefined): boolean {
  return !!path && SOURCE_FILE.test(path) && !/(?:^|\/)(?:node_modules|dist|build|\.next|vendor)\//.test(path) && !/\.min\.[jc]ss?$/.test(path);
}

/** Whether a bash command runs code (a check or a reproduction), and its identity. */
export function exerciseOf(command: string | undefined): { target: VerificationTarget | null; key: string } | null {
  const target = verificationTarget(command);
  const segs = commandSegments(command).filter((s) => !/^cd\b/.test(s));
  if (target) return { target, key: target.key };
  const run = segs.find((s) => REPRO.some((re) => re.test(s)));
  return run ? { target: null, key: run.replace(/\s+/g, ' ') } : null;
}

function failureItems(output: string | undefined): string[] {
  return failureSignature(output, 4000).split('; ').map((s) => s.trim()).filter(Boolean);
}

function sameExercise(a: Exercise, b: Exercise): boolean {
  if (a.target && b.target) return sameCheck(a.target, b.target);
  return !a.target && !b.target && a.key === b.key;
}

/** A failed or passed foreground run, or a background one read back from a later job result. */
function outcomeOf(results: SelfValidationResult[], i: number): { outcome: RunOutcome; output: string } {
  const r = results[i];
  if (r.background) {
    if (!r.success || !r.job_id) return { outcome: r.success ? 'pending' : 'not-started', output: r.output || '' };
    const ended = new RegExp(`\\bjob ${r.job_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^\\n]*exited with code (\\d+)`, 'i');
    for (const later of results.slice(i + 1)) {
      const m = ended.exec(later.output || '');
      if (!m) continue;
      const out = later.output || '';
      if (m[1] === '0') return { outcome: 'pass', output: out };
      return { outcome: NOT_STARTED.test(out) || m[1] === '127' ? 'not-started' : 'fail', output: out };
    }
    return { outcome: 'pending', output: '' };
  }
  const out = r.output || '';
  if (r.success) return { outcome: 'pass', output: out };
  return { outcome: NOT_STARTED.test(out) ? 'not-started' : 'fail', output: out };
}

function exercisesIn(results: SelfValidationResult[], from: number, to: number, worktreeId: string | undefined): Exercise[] {
  const out: Exercise[] = [];
  for (let i = from; i < to; i++) {
    const r = results[i];
    if (r.blocked) continue;
    // A run in another worktree (or the project folder) says nothing about this one's code.
    if (worktreeId && r.worktree_id && r.worktree_id !== worktreeId) continue;
    if (r.tool === 'bash') {
      const ex = exerciseOf(r.command);
      if (!ex) continue;
      const { outcome, output } = outcomeOf(results, i);
      out.push({ index: i, command: r.command || '', ...ex, outcome, failures: outcome === 'fail' ? failureItems(output) : [] });
    } else if (r.tool === 'run_tests') {
      const outcome: RunOutcome = r.success ? 'pass' : 'fail';
      out.push({ index: i, command: 'run_tests', target: null, key: 'run_tests', outcome, failures: outcome === 'fail' ? failureItems(r.output) : [] });
    } else if (LOOK_TOOLS.has(r.tool || '') && r.success) {
      out.push({ index: i, command: r.tool || '', target: null, key: r.tool || '', outcome: 'pass', failures: [] });
    }
  }
  return out;
}

const stemOf = (path: string) => (path.split('/').pop() || path).replace(/\.[^.]+$/, '').replace(/^test_|[._-](?:spec|test)$/i, '');

/**
 * Where this turn's change stands: did anything exercise it after its last source edit, in the chat's
 * worktree, and how did that go. `worktreeId` is the chat's worktree (runs in another one don't count).
 */
export function selfValidationState(results: SelfValidationResult[], worktreeId?: string): SelfValidationState {
  const editIdx = results.map((r, i) => (EDIT_TOOLS.has(r.tool || '') && r.success && !r.blocked && isSourceFile(r.path) ? i : -1)).filter((i) => i >= 0);
  if (!editIdx.length) return { status: 'no-edits', edited: [] };
  const edited = [...new Set(editIdx.map((i) => repoPath(results[i].path as string)))];
  const first = editIdx[0];
  const last = editIdx[editIdx.length - 1];
  const wt = worktreeId || results[last].worktree_id;

  const baseline = exercisesIn(results, 0, first, wt).filter((e) => e.outcome === 'fail');
  const after = exercisesIn(results, last + 1, results.length, wt);
  // The latest run of each check after the edit decides for that check.
  const latest: Exercise[] = [];
  for (const e of after) {
    const i = latest.findIndex((l) => sameExercise(l, e));
    if (i >= 0) latest.splice(i, 1);
    latest.push(e);
  }
  const stems = new Set(edited.map(stemOf).filter((s) => s.length >= 3));
  const namesChange = (item: string) => [...stems].some((s) => item.includes(s));

  let failed: SelfValidationState['failed'];
  const preExisting: string[] = [];
  let passed = false;
  for (const e of latest) {
    if (e.outcome === 'pass') {
      passed = true;
      continue;
    }
    if (e.outcome !== 'fail') continue;
    // Only a suite run (tests, typecheck, lint) has pre-existing failures: a reproduction that fails the
    // same way after the edit means the fix did not work.
    const before = new Set(e.target ? baseline.filter((b) => sameExercise(b, e)).flatMap((b) => b.failures) : []);
    const fresh = e.failures.filter((f) => !before.has(f) || namesChange(f));
    if (!fresh.length && e.failures.length) {
      preExisting.push(...e.failures);
      continue;
    }
    // A failure with no text captured is still a failure.
    failed = { command: e.command, failures: fresh.length ? fresh : ['failed, no error text captured'] };
  }
  if (failed) return { status: 'failed', edited, failed };
  if (passed) return { status: 'passed', edited };
  if (preExisting.length) return { status: 'pre-existing', edited, preExisting: [...new Set(preExisting)] };
  const pending = latest.find((e) => e.outcome === 'pending');
  if (pending) return { status: 'pending', edited, command: pending.command };
  const notStarted = latest.find((e) => e.outcome === 'not-started');
  if (notStarted) return { status: 'not-started', edited, command: notStarted.command };
  return { status: 'not-run', edited };
}

export type SelfValidationGate = { hold: true } | { hold: false; why: 'no-edits' | 'exercised' | 'bound' | 'no-room' };

/** Whether the turn is sent back to exercise its change. Bounded: never more than MAX_SELF_VALIDATION_NUDGES times. */
export function selfValidationGate(state: SelfValidationState, nudges: number, stepsLeft: number): SelfValidationGate {
  if (state.status === 'no-edits') return { hold: false, why: 'no-edits' };
  if (state.status === 'passed' || state.status === 'pre-existing') return { hold: false, why: 'exercised' };
  if (nudges >= MAX_SELF_VALIDATION_NUDGES) return { hold: false, why: 'bound' };
  if (stepsLeft < MIN_STEPS_LEFT) return { hold: false, why: 'no-room' };
  return { hold: true };
}

// ── the project's own checks ─────────────────────────────────────────

export interface DiscoveredCheck {
  command: string;
  /** Where it was read from (`apps/web/package.json scripts.test`). */
  from: string;
}

/** Reads a repo-relative file in the chat's worktree: its text, '' for a binary file, null when missing. */
export type ReadRepoFile = (path: string) => Promise<string | null>;

const MAX_READS = 16;
const MAX_CHECKS = 6;
const JS = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|css|scss|less|html?)$/i;
const PY = /\.pyi?$/i;

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const join = (dir: string, file: string) => (dir ? `${dir}/${file}` : file);
const inDir = (dir: string, cmd: string) => (dir ? `cd ${dir} && ${cmd}` : cmd);
/** A path relative to dir, without its extension: a jest/vitest path filter for the tests next to it. */
const filterFor = (dir: string, path: string) => (dir && path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path).replace(/\.[^./]+$/, '');

function ancestors(path: string): string[] {
  const out: string[] = [];
  let d = dirOf(path);
  for (;;) {
    out.push(d);
    if (!d) break;
    d = dirOf(d);
  }
  return out;
}

function packageManager(rootPkg: any, files: Map<string, string | null>): string {
  const declared = typeof rootPkg?.packageManager === 'string' ? rootPkg.packageManager : '';
  const m = /^(pnpm|yarn|bun|npm)@(\d+)/.exec(declared);
  // pnpm is often not installed where the agent runs (`pnpm: not found`): npx fetches it.
  if (m?.[1] === 'pnpm' || files.get('pnpm-lock.yaml') != null) return m?.[1] === 'pnpm' ? `npx pnpm@${m[2]}` : 'npx pnpm';
  if (m?.[1] === 'yarn' || files.get('yarn.lock') != null) return 'yarn';
  if (m?.[1] === 'bun' || files.get('bun.lockb') != null || files.get('bun.lock') != null) return 'bun';
  return 'npm';
}

function parseJson(text: string | null | undefined): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The project's own check commands for the files this turn changed, read from the repo: the nearest
 * package.json's scripts (with the package manager its lockfile names), pytest config, Makefile
 * targets, go.mod, Cargo.toml. Nothing is guessed: a repo with none of them gets an empty list.
 */
export async function discoverChecks(read: ReadRepoFile, edited: string[]): Promise<DiscoveredCheck[]> {
  const wanted: string[] = ['package.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Makefile'];
  const js = edited.filter((p) => JS.test(p));
  const py = edited.filter((p) => PY.test(p));
  const add = (p: string) => {
    if (!wanted.includes(p)) wanted.push(p);
  };
  for (const p of js) for (const d of ancestors(p)) add(join(d, 'package.json'));
  if (py.length) ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini'].forEach(add);
  for (const p of py) for (const d of ancestors(p)) if (d) add(join(d, 'pyproject.toml'));
  if (edited.some((p) => p.endsWith('.go'))) add('go.mod');
  if (edited.some((p) => p.endsWith('.rs'))) add('Cargo.toml');

  const paths = wanted.slice(0, MAX_READS);
  const texts = await Promise.all(paths.map((p) => read(p).catch(() => null)));
  const files = new Map(paths.map((p, i) => [p, texts[i]]));
  const checks: DiscoveredCheck[] = [];
  const push = (command: string, from: string) => {
    if (checks.length < MAX_CHECKS && !checks.some((c) => c.command === command)) checks.push({ command, from });
  };

  // JavaScript/TypeScript: the nearest package.json with scripts, for each edited file.
  const pm = packageManager(parseJson(files.get('package.json')), files);
  const pkgDirs = new Map<string, string[]>();
  for (const p of js) {
    const dir = ancestors(p).find((d) => parseJson(files.get(join(d, 'package.json')))?.scripts);
    if (dir === undefined) continue;
    pkgDirs.set(dir, [...(pkgDirs.get(dir) || []), p]);
  }
  for (const [dir, changed] of pkgDirs) {
    const scripts: Record<string, unknown> = parseJson(files.get(join(dir, 'package.json'))).scripts;
    const from = (name: string) => `${join(dir, 'package.json')} scripts.${name}`;
    const test = typeof scripts.test === 'string' ? scripts.test : '';
    const filters = changed.map((p) => filterFor(dir, p)).join(' ');
    if (/\bjest\b/.test(test)) push(inDir(dir, `npx jest ${filters}`), `${from('test')} (jest, only the tests next to the change)`);
    else if (/\bvitest\b/.test(test)) push(inDir(dir, `npx vitest run ${filters}`), `${from('test')} (vitest, only the tests next to the change)`);
    for (const name of ['test', 'typecheck', 'type-check', 'check-types', 'tsc', 'lint', 'check']) {
      if (typeof scripts[name] !== 'string' || /no test specified/.test(scripts[name] as string)) continue;
      push(inDir(dir, name === 'test' ? `${pm} test` : `${pm} run ${name}`), from(name));
    }
  }

  // Python: pytest when the repo configures it, ruff/mypy when it does.
  if (py.length) {
    const cfgs: Array<[string, RegExp]> = [['pytest.ini', /\[pytest\]/], ['pyproject.toml', /\[tool\.pytest/], ['setup.cfg', /\[tool:pytest\]/], ['tox.ini', /\[pytest\]/]];
    for (const p of py) for (const d of ancestors(p)) if (d) cfgs.push([join(d, 'pyproject.toml'), /\[tool\.pytest/]);
    const cfg = cfgs.find(([f, re]) => re.test(files.get(f) || ''));
    if (cfg) {
      const dir = dirOf(cfg[0]);
      const names = [...new Set(py.map(stemOf).filter(Boolean))].join(' or ');
      if (names) push(inDir(dir, `python -m pytest -q -k "${names}"`), `${cfg[0]} (pytest, the tests named like the change)`);
      push(inDir(dir, 'python -m pytest -q'), `${cfg[0]} (pytest)`);
    }
    const pyproject = files.get('pyproject.toml') || '';
    const rel = py.join(' ');
    if (/\[tool\.ruff/.test(pyproject)) push(`ruff check ${rel}`, 'pyproject.toml [tool.ruff]');
    if (/\[tool\.mypy/.test(pyproject)) push(`mypy ${rel}`, 'pyproject.toml [tool.mypy]');
  }

  if (files.get('go.mod') != null) {
    const dirs = [...new Set(edited.filter((p) => p.endsWith('.go')).map(dirOf))];
    push(`go test ${dirs.map((d) => (d ? `./${d}/...` : './...')).join(' ')}`, 'go.mod');
  }
  if (files.get('Cargo.toml') != null) push('cargo test', 'Cargo.toml');

  const make = files.get('Makefile') || '';
  for (const t of ['test', 'check', 'lint', 'typecheck']) if (new RegExp(`^${t}\\s*:`, 'm').test(make)) push(`make ${t}`, `Makefile target ${t}`);
  return checks;
}

// ── what the agent is told ───────────────────────────────────────────

const clip = (text: string, n: number) => {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The send-back: why the change isn't shown to work yet, and the project's own ways to show it. */
export function selfValidationNote(state: SelfValidationState, checks: DiscoveredCheck[], nudge: number): string {
  const files = state.edited.slice(0, 6).join(', ') + (state.edited.length > 6 ? `, … ${state.edited.length - 6} more` : '');
  const head =
    state.status === 'failed' && state.failed
      ? `⚠️ NOT DONE: after your last edit, \`${clip(state.failed.command, 160)}\` failed on:\n${state.failed.failures.slice(0, 6).map((f) => `- ${clip(f, 240)}`).join('\n')}\n`
        + 'Read what failed (the failing test and the line it names), say the cause in one line, fix it, and run the same check again. '
        + 'If the test is out of date with the change that was asked for, update the test, not the code back.'
      : state.status === 'pending'
        ? `⚠️ NOT DONE: \`${clip(state.command || '', 160)}\` is still running as a background job: wait_for it and read its result before answering.`
        : state.status === 'not-started'
          ? `⚠️ NOT DONE: \`${clip(state.command || '', 160)}\` did not run (the command or script does not exist here), so nothing has exercised your change yet.`
          : `⚠️ NOT DONE: you changed ${files}, and nothing has run since your last edit to show the change works.`;
  const how = checks.length
    ? `This repository's own checks for these files:\n${checks.map((c) => `- \`${c.command}\` (from ${c.from})`).join('\n')}`
    : 'No test, lint or typecheck script was found for these files in package.json, pytest config, a Makefile, go.mod or Cargo.toml: '
      + 'run a short reproduction instead (python -c / node -e, or a small script that calls the changed code).';
  return [
    head,
    'Before answering, run something in this chat\'s worktree that exercises the change: a reproduction of the reported bug '
      + '(it should fail before the fix and pass after), the tests next to the changed code, or the project\'s own checks below. '
      + 'Do not guess commands the repository does not have.',
    how,
    'Failures that were already there before your first edit (same check, same failure) are not counted against you: say so in the answer.',
    `(Self-check ${nudge} of ${MAX_SELF_VALIDATION_NUDGES}.)`,
  ].join('\n\n');
}
