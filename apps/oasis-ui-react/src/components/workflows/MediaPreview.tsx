/**
 * Unified output-previewer.
 *
 * Takes an arbitrary value, detects its media kind, and renders the most
 * appropriate viewer — a chosen subset of:
 *   text  /  html  /  image  /  video  /  audio  /  pdf
 *   word  /  powerpoint  /  excel   (via Office Online embed when reachable)
 *   3D    (glb/gltf via lazy-loaded <model-viewer>; link-only otherwise)
 *   web_url  (sandboxed iframe)
 *   json  (syntax-coloured dump)
 *
 * All embeds include an "open" / "download" link so the user always has a
 * fallback path if the iframe is blocked or the viewer can't handle the
 * asset.
 */

import { useEffect, useState } from 'react';
import { ExternalLink, Download, FileText, Image as ImageIcon, Video, Music, Globe, FileQuestion, Box, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  detectMediaKind, isPubliclyReachable, OFFICE_EMBED_URL,
  type MediaDescriptor, type MediaKind,
} from './media-utils';

interface MediaPreviewProps {
  value: unknown;
  /** Optional max height for the embedded preview. Defaults to 320px. */
  maxHeight?: number;
  className?: string;
}

export function MediaPreview({ value, maxHeight = 320, className }: MediaPreviewProps) {
  const d = detectMediaKind(value);
  const height = `${maxHeight}px`;

  if (d.kind === 'none') {
    return <p className="text-[11px] text-slate-500 italic">No output.</p>;
  }

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between text-[10px] text-slate-500">
        <span className="inline-flex items-center gap-1 uppercase tracking-wide">
          <KindIcon kind={d.kind} />
          {d.kind}{d.mime ? ` · ${d.mime}` : ''}
        </span>
        {d.url && (
          <div className="flex items-center gap-2">
            <a
              href={d.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-0.5 hover:text-slate-300"
            >
              <ExternalLink className="w-3 h-3" /> open
            </a>
            {!d.url.startsWith('data:') && !d.url.startsWith('blob:') && (
              <a
                href={d.url}
                download={d.filename}
                className="inline-flex items-center gap-0.5 hover:text-slate-300"
              >
                <Download className="w-3 h-3" /> download
              </a>
            )}
          </div>
        )}
      </div>

      <Renderer d={d} height={height} />
    </div>
  );
}

function KindIcon({ kind }: { kind: MediaKind }) {
  switch (kind) {
    case 'image':      return <ImageIcon className="w-3 h-3" />;
    case 'video':      return <Video className="w-3 h-3" />;
    case 'audio':      return <Music className="w-3 h-3" />;
    case 'pdf':
    case 'word':
    case 'powerpoint':
    case 'excel':      return <FileText className="w-3 h-3" />;
    case 'web_url':
    case 'html':       return <Globe className="w-3 h-3" />;
    case '3d':         return <Box className="w-3 h-3" />;
    case 'json':
    case 'text':       return <FileText className="w-3 h-3" />;
    default:           return <FileQuestion className="w-3 h-3" />;
  }
}

function Renderer({ d, height }: { d: MediaDescriptor; height: string }) {
  const frameBase = 'w-full border border-slate-800 rounded bg-slate-950';

  switch (d.kind) {
    case 'text':
      return (
        <pre
          style={{ maxHeight: height }}
          className="text-[11px] text-slate-300 bg-slate-950 border border-slate-800 rounded p-2 overflow-auto whitespace-pre-wrap break-words"
        >
          {d.text}
        </pre>
      );

    case 'json':
      return (
        <pre
          style={{ maxHeight: height }}
          className="text-[11px] text-slate-300 bg-slate-950 border border-slate-800 rounded p-2 overflow-auto font-mono"
        >
          {JSON.stringify(d.raw, null, 2)}
        </pre>
      );

    case 'html':
      return (
        <iframe
          srcDoc={d.html}
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          style={{ height }}
          className={frameBase}
          title="HTML preview"
        />
      );

    case 'image':
      return d.url ? (
        <img
          src={d.url}
          alt={d.filename || 'preview'}
          style={{ maxHeight: height }}
          className="max-w-full rounded border border-slate-800 bg-slate-950 object-contain"
        />
      ) : null;

    case 'video':
      return d.url ? (
        <video
          src={d.url}
          controls
          preload="metadata"
          style={{ maxHeight: height }}
          className="max-w-full rounded border border-slate-800 bg-black"
        />
      ) : null;

    case 'audio':
      return d.url ? <audio src={d.url} controls className="w-full" /> : null;

    case 'pdf':
      return d.url ? (
        <iframe
          src={d.url + '#view=FitH'}
          referrerPolicy="no-referrer"
          style={{ height }}
          className={frameBase}
          title="PDF preview"
        />
      ) : null;

    case 'word':
    case 'powerpoint':
    case 'excel':
      return <OfficePreview d={d} height={height} />;

    case 'web_url':
      return d.url ? (
        <iframe
          src={d.url}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          referrerPolicy="no-referrer-when-downgrade"
          style={{ height }}
          className={frameBase}
          title="Web preview"
          loading="lazy"
        />
      ) : null;

    case '3d':
      return d.url ? <ThreeDPreview d={d} height={height} /> : null;

    default:
      return (
        <pre className="text-[11px] text-slate-400 bg-slate-950 border border-slate-800 rounded p-2 overflow-auto">
          {JSON.stringify(d.raw, null, 2)}
        </pre>
      );
  }
}

/* ── Office Online embed ──────────────────────────────────────────
 * Requires a publicly reachable URL; private/local URLs fall back to a
 * download link.
 */
function OfficePreview({ d, height }: { d: MediaDescriptor; height: string }) {
  if (!d.url) return null;
  if (!isPubliclyReachable(d.url)) {
    return (
      <div className="rounded border border-slate-800 bg-slate-950 p-3 text-[11px] text-slate-400">
        Office documents can't be embedded from a private URL.
        {' '}
        <a href={d.url} download={d.filename} className="text-emerald-400 hover:text-emerald-300 underline">
          Download {d.filename ?? 'the file'}
        </a>
        {' '}to open it locally.
      </div>
    );
  }
  return (
    <iframe
      src={OFFICE_EMBED_URL + encodeURIComponent(d.url)}
      referrerPolicy="no-referrer"
      style={{ height }}
      className="w-full border border-slate-800 rounded bg-slate-950"
      title="Office preview"
      loading="lazy"
    />
  );
}

/* ── 3D preview via <model-viewer> (lazy-loaded on first use) ──────
 * We only attempt inline rendering for glb / gltf / usdz — the formats
 * <model-viewer> handles natively. Other 3D file types fall through to
 * a download card.
 */
function ThreeDPreview({ d, height }: { d: MediaDescriptor; height: string }) {
  const [loaded, setLoaded] = useState(() => typeof (globalThis as any).customElements?.get === 'function' && !!(globalThis as any).customElements.get('model-viewer'));
  const [error, setError] = useState<string | null>(null);
  const ext = (d.url || '').split('.').pop()?.toLowerCase() || '';
  const supported = ['glb', 'gltf', 'usdz'].includes(ext);

  useEffect(() => {
    if (loaded || !supported) return;
    const existing = document.querySelector<HTMLScriptElement>('script[data-oasis-model-viewer]');
    if (existing) {
      existing.addEventListener('load', () => setLoaded(true), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.type = 'module';
    s.src = 'https://cdn.jsdelivr.net/npm/@google/model-viewer@3.4.0/dist/model-viewer.min.js';
    s.dataset.oasisModelViewer = '1';
    s.onload = () => setLoaded(true);
    s.onerror = () => setError('Failed to load <model-viewer>');
    document.head.appendChild(s);
  }, [loaded, supported]);

  if (!supported) {
    return (
      <div className="rounded border border-slate-800 bg-slate-950 p-3 text-[11px] text-slate-400">
        3D format “{ext}” isn't rendered inline.
        {' '}
        <a href={d.url} download={d.filename} className="text-emerald-400 hover:text-emerald-300 underline">
          Download {d.filename ?? 'the file'}
        </a>.
      </div>
    );
  }

  if (error) {
    return <div className="text-[11px] text-red-400">{error}</div>;
  }

  if (!loaded) {
    return (
      <div className="flex items-center justify-center rounded border border-slate-800 bg-slate-950" style={{ height }}>
        <Loader2 className="w-4 h-4 text-slate-500 animate-spin" />
      </div>
    );
  }

  // <model-viewer> is a registered custom element; TS doesn't know about it.
  // Rendering via React.createElement avoids adding a JSX typing for a
  // third-party web component.
  return (
    <div
      className="w-full border border-slate-800 rounded bg-slate-950 overflow-hidden"
      style={{ height }}
      ref={(host) => {
        if (!host) return;
        if (host.firstChild) return;
        const el = document.createElement('model-viewer');
        el.setAttribute('src', d.url!);
        el.setAttribute('camera-controls', '');
        el.setAttribute('auto-rotate', '');
        el.setAttribute('shadow-intensity', '1');
        el.setAttribute('exposure', '1');
        el.style.width = '100%';
        el.style.height = '100%';
        el.style.background = 'transparent';
        host.appendChild(el);
      }}
    />
  );
}
