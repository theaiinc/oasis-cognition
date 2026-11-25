/**
 * Which shell commands are verification runs (tests, typecheck, lint, build), and what a failed run hit.
 *
 * Pure helpers used by self-validation.ts: a command's normalized identity (no `cd …&&`, env
 * prefix, output plumbing, `npx`/`corepack` wrappers or worktree paths; package-manager scope
 * options such as `--filter` read as the check's scope), whether two runs are the same check, and
 * a short signature of the failures a run's output shows.
 */

export type VerificationKind = 'test' | 'typecheck' | 'lint' | 'build';

export interface VerificationTarget {
  kind: VerificationKind;
  /** The tool that runs it (`jest`, `npm test`, `tsc`): runs over overlapping files of one runner count as one. */
  runner: string;
  /** Test files or paths it names (none: the whole suite). */
  files: string[];
  /** The command, normalized: no `cd …&&`, env prefix, output plumbing or `npx`. */
  key: string;
}

// ── which commands are verification ─────────────────────────────────

const PM = '(?:npm|pnpm|yarn|bun)';
/** [runner pattern, kind, runner name]; the first that matches a segment wins. */
const RUNNERS: Array<[RegExp, VerificationKind, string]> = [
  [new RegExp(`^${PM}(?:@[\\w.]+)? (?:run )?(?:test|tests)(?::[\\w:-]+)?\\b`), 'test', 'npm test'],
  [new RegExp(`^${PM}(?:@[\\w.]+)? (?:run )?(typecheck|type-check|tsc|check-types|types)(?::[\\w:-]+)?\\b`), 'typecheck', 'npm run typecheck'],
  [new RegExp(`^${PM}(?:@[\\w.]+)? (?:run )?(lint)(?::[\\w:-]+)?\\b`), 'lint', 'npm run lint'],
  [new RegExp(`^${PM}(?:@[\\w.]+)? (?:run )?(build)(?::[\\w:-]+)?\\b`), 'build', 'npm run build'],
  [new RegExp(`^${PM}(?:@[\\w.]+)? run (check|verify|ci)\\b`), 'test', 'npm run check'],
  [/^jest\b/, 'test', 'jest'],
  [/^vitest\b/, 'test', 'vitest'],
  [/^mocha\b/, 'test', 'mocha'],
  [/^playwright test\b/, 'test', 'playwright'],
  [/^(?:python3? -m )?pytest\b/, 'test', 'pytest'],
  [/^(?:python3? -m )?unittest\b/, 'test', 'unittest'],
  [/^go test\b/, 'test', 'go test'],
  [/^go (?:build|vet)\b/, 'build', 'go build'],
  [/^cargo test\b/, 'test', 'cargo test'],
  [/^cargo (?:build|check|clippy)\b/, 'build', 'cargo build'],
  [/^make (?:test|check)\b/, 'test', 'make test'],
  [/^make build\b/, 'build', 'make build'],
  [/^tsc\b/, 'typecheck', 'tsc'],
  [/^vue-tsc\b/, 'typecheck', 'tsc'],
  [/^(?:python3? -m )?mypy\b/, 'typecheck', 'mypy'],
  [/^pyright\b/, 'typecheck', 'pyright'],
  [/^eslint\b/, 'lint', 'eslint'],
  [/^(?:biome|ruff|flake8|pylint|golangci-lint)\b/, 'lint', 'lint'],
  [/^(?:next|vite|nest) build\b/, 'build', 'build'],
];

/** Options whose next word is a value, not a file (`-t "name"`, `-k expr`). */
const VALUE_OPTIONS = new Set(['-t', '--testNamePattern', '-k', '-g', '--grep', '-run', '--run', '-p', '--project', '-c', '--config', '--testPathPattern', '--reporter', '--maxWorkers', '-m', '--filter', '-F', '--prefix', '-C', '--dir', '--cwd', '--workspace', '-w']);

/** Package-manager options before the script that pick where it runs (its scope), and take a value. */
const PM_SCOPE_OPTIONS = new Set(['--filter', '-F', '--prefix', '-C', '--dir', '--cwd', '--workspace', '-w']);

/** A path inside a chat's worktree, relative to it: the same check from two worktrees is one check. */
export function withoutWorktree(text: string): string {
  // The dev-agent's `<repo>/.oasis-worktrees/<id>/`, and git's or Claude's `…/worktrees/<id>/`.
  // The worktree itself (`cd <it>`, `--prefix <it>`) is `.`.
  return text.replace(/(?:~|\.)?(?:\/[^\s/'"]+)*\/(?:\.oasis-worktrees|\.?worktrees)\/[^\s/'"]+(?:\/|(?=[\s'"]|$))/g, (m) => (m.endsWith('/') ? '' : '.'));
}

function tokens(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));
}

/** One shell segment with its environment prefix, wrappers and redirections taken off. */
function bare(segment: string): string {
  let s = segment.trim()
    .replace(/\s\d?>>?\s*&?\S+/g, ' ') // 2>&1, > out.log
    .replace(/\s\d?<\s*\S+/g, ' ');
  for (;;) {
    const before = s;
    s = s.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '')
      .replace(/^(?:time|timeout(?:\s+-\S+)*\s+\d+[smh]?|nice|env)\s+/, '')
      .replace(/^(?:npx|corepack|pnpm (?:exec|dlx)|yarn (?:exec|dlx)|bunx|uv run|poetry run)(?:\s+--\S+)*\s+/, '')
      .trim();
    if (s === before) break;
  }
  return s.replace(/\s+/g, ' ');
}

function filesOf(rest: string[]): string[] {
  const files: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--') continue;
    if (t.startsWith('-')) {
      if (VALUE_OPTIONS.has(t)) i++;
      continue;
    }
    if (/[/.]/.test(t) && !/^\.\.?$/.test(t)) files.push(withoutWorktree(t).replace(/::.*$/, '').replace(/^\.\//, ''));
  }
  return [...new Set(files)].sort();
}

/**
 * A package-manager call with its global options taken out (`pnpm --filter pkg test` is
 * `pnpm test` scoped to pkg; `yarn workspace pkg test` too), so RUNNERS can read the script.
 */
function scoped(seg: string): { seg: string; scope: string } {
  const raw = seg.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const pm = raw[0] || '';
  if (!/^(?:npm|pnpm|yarn|bun)(?:@[\w.]+)?$/.test(pm)) return { seg, scope: '' };
  const unquote = (t: string) => t.replace(/^["']|["']$/g, '');
  const scope: string[] = [];
  let i = 1;
  for (; i < raw.length; i++) {
    const t = unquote(raw[i]);
    if (t === 'workspace' && /^yarn/.test(pm) && raw[i + 1]) {
      scope.push(unquote(raw[++i]));
      continue;
    }
    if (!t.startsWith('-') || t === '--') break;
    const [name, value] = t.split(/=(.*)/s, 2);
    if (!PM_SCOPE_OPTIONS.has(name)) continue; // a flag (-r, --silent, --if-present)
    // pnpm's -w is the workspace root, not a value option.
    if (name === '-w' && /^pnpm/.test(pm)) {
      scope.push('(root)');
      continue;
    }
    const v = value !== undefined ? value : raw[i + 1] !== undefined ? unquote(raw[++i]) : '';
    if (v) scope.push(withoutWorktree(v).replace(/^\.\//, '').replace(/\/$/, '') || '.');
  }
  if (i === 1) return { seg, scope: '' };
  return { seg: [pm, ...raw.slice(i)].join(' '), scope: [...new Set(scope)].sort().join(',') };
}

/** What a shell command verifies, or null for any other command. */
export function verificationTarget(command: string | undefined): VerificationTarget | null {
  const c = (command || '').trim();
  if (!c) return null;
  // Servers and watchers aren't a verdict on the code.
  if (/--watch\b|\bwatch\b/.test(c)) return null;
  for (const raw of c.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
    const { seg, scope } = scoped(withoutWorktree(bare(raw)));
    if (!seg || /^cd\b/.test(seg)) continue;
    for (const [re, kind, runner] of RUNNERS) {
      const m = re.exec(seg);
      if (!m) continue;
      const rest = tokens(seg.slice(m[0].length));
      const where = scope ? ` [${scope}]` : '';
      return { kind, runner: `${runner}${where}`, files: filesOf(rest), key: `${seg}${where}` };
    }
  }
  return null;
}

/** A command's shell segments, each with its env prefix, wrappers (npx, timeout…), redirections and worktree paths taken off. */
export function commandSegments(command: string | undefined): string[] {
  return (command || '').trim().split(/\s*(?:&&|\|\||;|\|)\s*/).map((raw) => withoutWorktree(bare(raw))).filter(Boolean);
}

export function isVerificationCommand(command: string | undefined): boolean {
  return verificationTarget(command) !== null;
}

/** Whether two runs are the same check: the same command, or one runner over overlapping files. */
export function sameCheck(a: VerificationTarget, b: VerificationTarget): boolean {
  if (a.key === b.key) return true;
  if (a.runner !== b.runner) return false;
  if (!a.files.length || !b.files.length) return !a.files.length && !b.files.length;
  return a.files.some((f) => b.files.includes(f));
}

// ── what a failure was ───────────────────────────────────────────────

/**
 * A short description of what a failed run hit: failing tests, compile errors, or the first error
 * lines. Compared across runs, these show a chat flip-flopping between failures.
 */
export function failureSignature(output: string | undefined, limit = 300): string {
  const text = (output || '').replace(/\u001b\[[0-9;]*m/g, '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const found: string[] = [];
  const failedFiles: string[] = [];
  const add = (s: string) => {
    const t = s.replace(/\s+/g, ' ').trim();
    if (t && !found.includes(t)) found.push(t);
  };
  for (const l of lines) {
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^●\s+(.+?)\s*$/)) && !/^Test suite failed to run/.test(m[1])) add(m[1]);
    else if ((m = l.match(/(\S+?)(?:\((\d+),\d+\)|:(\d+):\d+)\s*(?:-\s*)?:?\s*error (TS\d+): (.*)$/))) add(`${m[1]}:${m[2] || m[3]} ${m[4]} ${m[5]}`);
    else if ((m = l.match(/^error (TS\d+): (.*)$/))) add(`${m[1]} ${m[2]}`);
    else if ((m = l.match(/^FAILED (\S+)/))) add(m[1]);
    else if ((m = l.match(/^--- FAIL: (\S+)/))) add(m[1]);
    else if ((m = l.match(/^test (\S+) \.\.\. FAILED/))) add(m[1]);
    else if ((m = l.match(/^FAIL\s+(\S+)/))) failedFiles.push(`FAIL ${m[1]}`);
    if (found.length >= 4) break;
  }
  // Failing test files only when nothing names the failure itself.
  if (!found.length) failedFiles.slice(0, 4).forEach(add);
  if (!found.length) {
    for (const l of lines) {
      if (/\b(error|failed|failure|cannot|not found)\b|✕|×/i.test(l)) add(l);
      if (found.length >= 2) break;
    }
  }
  if (!found.length && lines.length) add(lines[lines.length - 1]);
  const sig = found.join('; ');
  return sig.length > limit ? `${sig.slice(0, limit - 1)}…` : sig;
}
