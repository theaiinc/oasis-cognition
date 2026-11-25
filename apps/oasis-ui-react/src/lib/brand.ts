import oasisLogo from '@/assets/oasis-logo.svg';

/**
 * Single source of truth for product naming, so a fork only needs to set
 * VITE_BRAND_NAME / VITE_BRAND_SHORT_NAME / VITE_BRAND_LOGO (see .env.example)
 * instead of editing component copy or shared assets. Components stay
 * identical across forks except for these constants, which keeps merges from
 * upstream free of branding conflicts.
 */
export const BRAND_NAME = (import.meta.env.VITE_BRAND_NAME || 'Oasis Cognition').trim();
export const BRAND_SHORT_NAME = (import.meta.env.VITE_BRAND_SHORT_NAME || 'Oasis').trim();

/** Logos bundled with the app, by key. A fork can add its own entry here. */
const LOGOS: Record<string, string> = {
  oasis: oasisLogo,
};

/**
 * VITE_BRAND_LOGO: a key in LOGOS, or a URL (e.g. /brand-logo.svg placed in
 * public/). Anything else falls back to the Oasis logo.
 */
function resolveLogo(value: string): string {
  if (!value) return oasisLogo;
  if (LOGOS[value.toLowerCase()]) return LOGOS[value.toLowerCase()];
  if (value.startsWith('/') || /^https?:\/\//i.test(value)) return value;
  return oasisLogo;
}

export const BRAND_LOGO = resolveLogo((import.meta.env.VITE_BRAND_LOGO || '').trim());
