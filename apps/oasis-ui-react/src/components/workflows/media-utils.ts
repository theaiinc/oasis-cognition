/**
 * Media-type detection for arbitrary node outputs.
 *
 * A node's output can be literally anything a tool/expression produced —
 * a URL string, a data URL, inline HTML, a plain text blob, a structured
 * object with {url, mime_type}, etc. `detectMediaKind` normalises whatever
 * we get into a `MediaDescriptor` that the MediaPreview component can
 * switch over.
 */

export type MediaKind =
  | 'none'
  | 'text'
  | 'html'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'word'
  | 'powerpoint'
  | 'excel'
  | '3d'
  | 'web_url'
  | 'json';

export interface MediaDescriptor {
  kind: MediaKind;
  /** For url-based media: the URL to render. Data URLs are passed through. */
  url?: string;
  /** MIME type if known. */
  mime?: string;
  /** For text-kind: the raw text. */
  text?: string;
  /** For html-kind: the raw HTML string. */
  html?: string;
  /** A filename hint (derived from the URL path or an explicit field). */
  filename?: string;
  /** The unmodified original value, always preserved for debugging / JSON fallback. */
  raw: unknown;
}

/* ── File-extension + MIME lookup tables ──────────────────────────── */

const EXT_TO_KIND: Record<string, MediaKind> = {
  // image
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image',
  webp: 'image', svg: 'image', bmp: 'image', avif: 'image',
  // video
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video',
  avi: 'video', mkv: 'video', ogv: 'video',
  // audio
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio',
  flac: 'audio', aac: 'audio', opus: 'audio', weba: 'audio',
  // documents
  pdf: 'pdf',
  doc: 'word', docx: 'word',
  ppt: 'powerpoint', pptx: 'powerpoint',
  xls: 'excel', xlsx: 'excel', csv: 'excel',
  // 3D
  glb: '3d', gltf: '3d', obj: '3d', stl: '3d', fbx: '3d', ply: '3d', usdz: '3d',
  // html
  html: 'html', htm: 'html',
};

function detectByMime(mime: string): MediaKind | null {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('model/')) return '3d';
  if (m === 'application/pdf') return 'pdf';
  if (m.includes('wordprocessing') || m === 'application/msword') return 'word';
  if (m.includes('presentation') || m === 'application/vnd.ms-powerpoint') return 'powerpoint';
  if (m.includes('spreadsheet') || m === 'application/vnd.ms-excel' || m === 'text/csv') return 'excel';
  if (m === 'text/html' || m === 'application/xhtml+xml') return 'html';
  if (m === 'application/json' || m === 'application/ld+json') return 'json';
  if (m.startsWith('text/')) return 'text';
  return null;
}

function extOf(url: string): string {
  try {
    const u = new URL(url, 'http://dummy.local');
    const path = u.pathname;
    const i = path.lastIndexOf('.');
    if (i < 0) return '';
    return path.slice(i + 1).toLowerCase();
  } catch {
    const i = url.lastIndexOf('.');
    if (i < 0) return '';
    // Strip query/fragment
    const tail = url.slice(i + 1);
    return tail.split(/[?#]/)[0].toLowerCase();
  }
}

function filenameOf(url: string): string | undefined {
  try {
    const u = new URL(url, 'http://dummy.local');
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg ? decodeURIComponent(seg) : undefined;
  } catch {
    return undefined;
  }
}

function detectByExtension(url: string): MediaKind | null {
  return EXT_TO_KIND[extOf(url)] ?? null;
}

const HTML_LOOKALIKE = /^\s*<(?:!doctype\s|html[\s>]|body[\s>]|div[\s>]|section[\s>]|article[\s>]|h[1-6][\s>]|p[\s>]|span[\s>]|ul[\s>]|ol[\s>]|table[\s>])/i;

export function detectMediaKind(value: unknown): MediaDescriptor {
  // ── null / undefined ────────────────────────────────────────────
  if (value == null) return { kind: 'none', raw: value };

  // ── Object with single `out` port → unwrap (engine convention) ──
  if (
    typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value as object).length === 1 && 'out' in (value as object)
  ) {
    return detectMediaKind((value as { out: unknown }).out);
  }

  // ── String cases ────────────────────────────────────────────────
  if (typeof value === 'string') {
    // Data URL (base64 or percent-encoded inline payload)
    const m = value.match(/^data:([^;,]+)/);
    if (m) {
      const mime = m[1].toLowerCase();
      const byMime = detectByMime(mime);
      if (byMime) return { kind: byMime, url: value, mime, raw: value };
      // Unknown mime — fall through
    }

    // HTTP(S) URL
    if (/^https?:\/\//i.test(value)) {
      const byExt = detectByExtension(value);
      const filename = filenameOf(value);
      if (byExt) return { kind: byExt, url: value, filename, raw: value };
      return { kind: 'web_url', url: value, filename, raw: value };
    }

    // Blob URL (e.g. from object URL creation)
    if (value.startsWith('blob:')) {
      return { kind: 'web_url', url: value, raw: value };
    }

    // Inline HTML
    if (HTML_LOOKALIKE.test(value)) {
      return { kind: 'html', html: value, raw: value };
    }

    // Plain text
    return { kind: 'text', text: value, raw: value };
  }

  // ── Object with hints ───────────────────────────────────────────
  if (typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, any>;
    const url =
      typeof v.url === 'string' ? v.url :
      typeof v.href === 'string' ? v.href :
      typeof v.download_url === 'string' ? v.download_url :
      typeof v.src === 'string' ? v.src : undefined;
    const mime =
      typeof v.mime_type === 'string' ? v.mime_type :
      typeof v.content_type === 'string' ? v.content_type :
      typeof v.mime === 'string' ? v.mime : undefined;
    const filename =
      typeof v.filename === 'string' ? v.filename :
      typeof v.name === 'string' ? v.name :
      url ? filenameOf(url) : undefined;

    if (url) {
      if (mime) {
        const byMime = detectByMime(mime);
        if (byMime) return { kind: byMime, url, mime, filename, raw: value };
      }
      const byExt = detectByExtension(url);
      if (byExt) return { kind: byExt, url, mime, filename, raw: value };
      return { kind: 'web_url', url, mime, filename, raw: value };
    }

    if (typeof v.html === 'string') return { kind: 'html', html: v.html, raw: value };
    if (typeof v.text === 'string') return { kind: 'text', text: v.text, raw: value };
    if (typeof v.content === 'string') return { kind: 'text', text: v.content, raw: value };

    // Fallback → JSON
    return { kind: 'json', raw: value };
  }

  // ── Primitives (number / boolean) → text ────────────────────────
  return { kind: 'text', text: String(value), raw: value };
}

/* ── Small helpers used by the preview component ─────────────────── */

export const OFFICE_EMBED_URL = 'https://view.officeapps.live.com/op/embed.aspx?src=';

/** True if the URL is reachable from the public internet (heuristic). The
 *  Office Online viewer and similar embeds need this. */
export function isPubliclyReachable(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const h = u.hostname;
    if (!h) return false;
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
    if (/^10\./.test(h)) return false;
    if (/^192\.168\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (h.endsWith('.local') || h.endsWith('.lan')) return false;
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
