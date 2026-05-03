import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { X, Download, FileText, Image as ImageIcon, FileQuestion } from 'lucide-react';
import { OASIS_BASE_URL } from '@/lib/constants';
import { CodeBlock } from './CodeBlock';

const TEXT_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'mdx', 'html', 'htm',
  'css', 'scss', 'sass', 'py', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'cs',
  'c', 'cpp', 'h', 'hpp', 'sh', 'bash', 'zsh', 'fish', 'yml', 'yaml', 'toml',
  'ini', 'cfg', 'env', 'gitignore', 'dockerfile', 'sql', 'graphql', 'proto',
  'txt', 'log', 'csv', 'tsv', 'xml',
]);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);
const PDF_EXT = new Set(['pdf']);

type Kind = 'text' | 'image' | 'pdf' | 'unknown';

function getExt(path: string): string {
  const m = path.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}

function getKind(path: string): Kind {
  const ext = getExt(path);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (PDF_EXT.has(ext)) return 'pdf';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'unknown';
}

function langForExt(ext: string): string {
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', go: 'go', rs: 'rust', md: 'markdown',
    sh: 'bash', yml: 'yaml', yaml: 'yaml',
  };
  return map[ext] || ext;
}

export interface OpenFileOpts {
  path: string;
  worktreeId?: string;
  line?: number;
}

interface FileViewerProps extends OpenFileOpts {
  onClose: () => void;
}

export function FileViewer({ path, worktreeId, line, onClose }: FileViewerProps) {
  const kind = getKind(path);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const ext = getExt(path);

  const params = new URLSearchParams({ path });
  if (worktreeId) params.set('worktree_id', worktreeId);
  const binaryUrl = `${OASIS_BASE_URL}/api/v1/files?${params.toString()}`;

  useEffect(() => {
    if (kind !== 'text') return;
    setLoading(true);
    setError(null);
    fetch(`${OASIS_BASE_URL}/api/v1/files/text?${params.toString()}`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) {
          setError(d?.error || 'Failed to load');
          return;
        }
        if (d.success === false) {
          setError(d.error === 'binary' ? 'File is binary; download to inspect.' : (d.error || 'Failed'));
          return;
        }
        setText(d.content ?? '');
      })
      .catch((e) => setError(String(e?.message || e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, worktreeId, kind]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const Icon = kind === 'image' ? ImageIcon : kind === 'unknown' ? FileQuestion : FileText;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`File preview: ${path}`}
    >
      <div
        className="bg-[#0a0f1a] rounded-lg border border-slate-800 shadow-xl overflow-hidden flex flex-col"
        style={{ width: '90vw', maxWidth: 1200, height: '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Icon className="w-4 h-4 text-slate-400 shrink-0" />
            <span className="text-sm font-mono text-slate-200 truncate" title={path}>{path}</span>
            {line ? <span className="text-xs text-slate-500 shrink-0">:{line}</span> : null}
            {worktreeId ? <span className="text-[10px] text-slate-500 font-mono shrink-0">({worktreeId})</span> : null}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <a
              href={binaryUrl}
              download
              className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-800"
              title="Download"
            >
              <Download className="w-4 h-4" />
            </a>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-800"
              title="Close (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-slate-950">
          {kind === 'text' && (
            <>
              {loading && <div className="p-4 text-xs text-slate-500">Loading…</div>}
              {error && <div className="p-4 text-xs text-red-400">Error: {error}</div>}
              {text != null && !error && (
                <CodeBlock className={`language-${langForExt(ext)}`}>{text}</CodeBlock>
              )}
            </>
          )}
          {kind === 'image' && (
            <div className="flex items-center justify-center p-4 h-full">
              <img src={binaryUrl} alt={path} className="max-w-full max-h-full object-contain" />
            </div>
          )}
          {kind === 'pdf' && (
            <iframe src={binaryUrl} className="w-full h-full border-0" title={path} />
          )}
          {kind === 'unknown' && (
            <div className="p-6 text-sm text-slate-400 space-y-2">
              <p>
                Preview not available for <code className="text-slate-200">.{ext || '(no extension)'}</code> files.
              </p>
              <a
                href={binaryUrl}
                download
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200"
              >
                <Download className="w-4 h-4" /> Download
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Context provider ──────────────────────────────────────────────────────

interface Ctx {
  openFile: (opts: OpenFileOpts) => void;
}

const FileViewerContext = createContext<Ctx | null>(null);

const NOOP_CTX: Ctx = { openFile: () => {} };

export function useFileViewer(): Ctx {
  return useContext(FileViewerContext) ?? NOOP_CTX;
}

export function FileViewerProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<OpenFileOpts | null>(null);
  const openFile = useCallback((opts: OpenFileOpts) => setActive(opts), []);
  return (
    <FileViewerContext.Provider value={{ openFile }}>
      {children}
      {active && (
        <FileViewer
          path={active.path}
          worktreeId={active.worktreeId}
          line={active.line}
          onClose={() => setActive(null)}
        />
      )}
    </FileViewerContext.Provider>
  );
}

// ── Helpers for markdown link detection ──────────────────────────────────

const EXTERNAL_PROTO = /^(https?|mailto|tel|data|ws|wss):/i;

/** Does this href look like a project file we should preview in-app? */
export function isInternalFileLink(href: string): boolean {
  if (!href) return false;
  if (href.startsWith('#')) return false;
  if (EXTERNAL_PROTO.test(href)) return false;
  if (href.startsWith('file://')) return true;
  if (href.startsWith('./') || href.startsWith('../') || href.startsWith('/')) return true;
  // Bare relative path like "src/foo.ts" or "src/foo.ts:42"
  return /\.[a-z0-9]{1,8}(:\d+)?$/i.test(href);
}

/** Split "path/to/foo.ts:42" into { path, line }. The line: suffix is optional. */
export function parseFileHref(href: string): { path: string; line?: number } {
  const cleaned = href.startsWith('file://') ? href.slice('file://'.length) : href;
  const m = cleaned.match(/^(.*?):(\d+)$/);
  if (m) return { path: m[1], line: parseInt(m[2], 10) };
  return { path: cleaned };
}
