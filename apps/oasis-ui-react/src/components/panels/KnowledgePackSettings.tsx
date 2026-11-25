import { useRef, useState } from 'react';
import axios from 'axios';
import { Download, Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OASIS_BASE_URL } from '@/lib/constants';
import { BRAND_SHORT_NAME } from '@/lib/brand';

interface Props {
  activeProjectId?: string;
  activeProjectName?: string;
}

interface ImportReport {
  added: Array<{ type: string; label: string }>;
  skipped: Array<{ type: string; label: string; reason: string }>;
  counts: { added: number; skipped: number };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'knowledge';
}

function errorText(err: any): string {
  const msg = err?.response?.data?.message;
  return typeof msg === 'string' ? msg : err?.message || 'unknown error';
}

/**
 * Settings → Knowledge: download the active project's rules as a knowledge pack, and
 * upload a pack to merge it into the project (knowledge-packs.service.ts).
 */
export function KnowledgePackSettings({ activeProjectId, activeProjectName }: Props) {
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const projectId = activeProjectId;
  const targetName = activeProjectName || 'this project';

  const download = async () => {
    setBusy('export'); setError(null); setReport(null);
    try {
      const name = `${activeProjectName || 'Project'} knowledge`;
      const res = await axios.get(`${OASIS_BASE_URL}/api/v1/knowledge-packs/export`, {
        params: { ...(projectId ? { project_id: projectId } : {}), name },
      });
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slug(name)}-${new Date().toISOString().slice(0, 10)}.knowledge-pack.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(`Couldn't download the pack: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file: File) => {
    setBusy('import'); setError(null); setReport(null);
    try {
      let pack: unknown;
      try { pack = JSON.parse(await file.text()); } catch { throw new Error('that file is not JSON'); }
      const res = await axios.post(`${OASIS_BASE_URL}/api/v1/knowledge-packs/import`, {
        pack, ...(projectId ? { project_id: projectId } : {}),
      }, { timeout: 60000 });
      setReport(res.data as ImportReport);
    } catch (err) {
      setError(`Couldn't import the pack: ${errorText(err)}`);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="pt-3 border-b border-slate-800 pb-4">
        <h3 className="text-xs text-slate-300 font-medium mb-1">Knowledge packs</h3>
        <p className="text-[11px] text-slate-500 mb-3">
          The rules {BRAND_SHORT_NAME} has learned for a project, as one JSON file: take them into another
          project, or keep a copy. Importing adds only what isn't there yet; global rules are never included,
          and every item is marked private.
        </p>

        <p className="text-xs text-slate-300 mb-3">
          {activeProjectId ? `Project: ${activeProjectName || activeProjectId}` : 'Choose a project first (Project tab).'}
        </p>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!!busy || !activeProjectId} onClick={() => void download()}>
            {busy === 'export' ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Download className="w-3.5 h-3.5 mr-1" />}
            Download pack
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!!busy || !activeProjectId} onClick={() => fileRef.current?.click()}>
            {busy === 'import' ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Upload className="w-3.5 h-3.5 mr-1" />}
            Upload pack into {targetName}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }}
          />
        </div>

        {error && <p className="mt-3 text-[11px] text-red-300">{error}</p>}
        {report && (
          <div className="mt-3 rounded-md border border-slate-800 bg-slate-900/50 p-2.5 text-[11px]" role="status">
            <div className="text-slate-200 mb-1">
              Added {report.counts.added}, skipped {report.counts.skipped}.
            </div>
            {report.added.length > 0 && (
              <ul className="mb-1 list-disc pl-4 text-emerald-300/90">
                {report.added.slice(0, 20).map((a, i) => <li key={`a${i}`}>{a.type}: {a.label}</li>)}
                {report.added.length > 20 && <li>…and {report.added.length - 20} more</li>}
              </ul>
            )}
            {report.skipped.length > 0 && (
              <ul className="list-disc pl-4 text-slate-500">
                {report.skipped.slice(0, 20).map((s, i) => <li key={`s${i}`}>{s.type}: {s.label} ({s.reason})</li>)}
                {report.skipped.length > 20 && <li>…and {report.skipped.length - 20} more</li>}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
