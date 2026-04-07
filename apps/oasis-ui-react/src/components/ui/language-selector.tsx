/**
 * Reusable language selector dropdown.
 *
 * Available languages are configured via localStorage key `oasis_languages`.
 * Default set is provided if none configured.
 */
import { useState, useRef, useEffect } from 'react';
import { ChevronDown, X, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface LanguageOption {
  code: string;   // e.g. "vi", "en", "ja"
  label: string;  // e.g. "Vietnamese", "English", "Japanese"
}

const STORAGE_KEY = 'oasis_languages';
const SELECTED_KEY = 'oasis_artifact_language';

/** Built-in defaults if user hasn't configured any */
const DEFAULT_LANGUAGES: LanguageOption[] = [
  { code: 'vi', label: 'Vietnamese' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ko', label: 'Korean' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'es', label: 'Spanish' },
  { code: 'th', label: 'Thai' },
  { code: 'id', label: 'Indonesian' },
];

/** Read configured languages from localStorage (falls back to defaults) */
export function getConfiguredLanguages(): LanguageOption[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as LanguageOption[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* ignore */ }
  return DEFAULT_LANGUAGES;
}

/** Save configured languages to localStorage */
export function setConfiguredLanguages(languages: LanguageOption[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(languages));
}

/** Get the persisted selected language code */
export function getSelectedLanguage(): string {
  return localStorage.getItem(SELECTED_KEY) || '';
}

/** Persist the selected language code */
export function setSelectedLanguage(code: string) {
  localStorage.setItem(SELECTED_KEY, code);
}

// ─── Component ───────────────────────────────────────────────────────

interface LanguageSelectorProps {
  value: string;                          // current language code or label
  onChange: (code: string, label: string) => void;
  placeholder?: string;
  className?: string;
  size?: 'sm' | 'md';
  allowEmpty?: boolean;                   // show "Auto-detect" option
}

export function LanguageSelector({
  value,
  onChange,
  placeholder = 'Language',
  className,
  size = 'sm',
  allowEmpty = true,
}: LanguageSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const languages = getConfiguredLanguages();

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Resolve display label
  const match = languages.find(l => l.code === value || l.label === value);
  const displayLabel = match?.label || value || '';

  const h = size === 'sm' ? 'h-7' : 'h-8';
  const textSize = size === 'sm' ? 'text-[11px]' : 'text-xs';

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-1.5 w-full px-2 rounded border bg-slate-950 border-slate-700 text-slate-300 hover:border-slate-500 transition-colors',
          h, textSize,
        )}
      >
        <Globe className="h-3 w-3 text-slate-500 shrink-0" />
        <span className="flex-1 text-left truncate">
          {displayLabel || <span className="text-slate-600">{placeholder}</span>}
        </span>
        {value && allowEmpty && (
          <X
            className="h-3 w-3 text-slate-500 hover:text-slate-300 shrink-0"
            onClick={e => { e.stopPropagation(); onChange('', ''); }}
          />
        )}
        <ChevronDown className={cn('h-3 w-3 text-slate-500 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[160px] max-h-48 overflow-y-auto rounded border border-slate-700 bg-slate-900 shadow-xl">
          {allowEmpty && (
            <button
              type="button"
              className={cn(
                'w-full px-3 py-1.5 text-left hover:bg-slate-800 transition-colors',
                textSize,
                !value ? 'text-blue-400' : 'text-slate-400',
              )}
              onClick={() => { onChange('', ''); setOpen(false); }}
            >
              Auto-detect
            </button>
          )}
          {languages.map(lang => (
            <button
              key={lang.code}
              type="button"
              className={cn(
                'w-full px-3 py-1.5 text-left hover:bg-slate-800 transition-colors flex items-center justify-between',
                textSize,
                (value === lang.code || value === lang.label) ? 'text-blue-400 bg-slate-800/50' : 'text-slate-300',
              )}
              onClick={() => { onChange(lang.code, lang.label); setOpen(false); }}
            >
              <span>{lang.label}</span>
              <span className="text-slate-600 text-[10px]">{lang.code}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
