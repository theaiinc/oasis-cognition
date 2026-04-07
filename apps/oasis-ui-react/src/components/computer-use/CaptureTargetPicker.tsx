/**
 * Capture Target Picker — Chrome-style modal for choosing what to share.
 *
 * Tabs: "Entire Screen" (shows each display) | "Window" (lists visible apps).
 * Each item shows a live preview thumbnail when possible.
 * Uses dev-agent pyautogui for screenshots — requires macOS Screen Recording permission.
 */

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { motion } from 'framer-motion';
import {
  Monitor, AppWindow, Loader2, X, Check, RefreshCw, AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { OASIS_BASE_URL } from '@/lib/constants';

export type CaptureMode = 'full_screen' | 'screen' | 'window';

export interface CaptureTarget {
  mode: CaptureMode;
  /** Screen index (when mode is 'screen'), or app name (when mode is 'window'). */
  target?: string;
  /** Display label for the UI. */
  label?: string;
}

interface ScreenInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  thumbnail: string;
}

interface WindowInfo {
  app: string;
  title: string;
  thumbnail?: string;
  icon?: string;
}

interface CaptureTargetPickerProps {
  open: boolean;
  onSelect: (target: CaptureTarget) => void;
  onCancel: () => void;
}

export function CaptureTargetPicker({ open, onSelect, onCancel }: CaptureTargetPickerProps) {
  const [tab, setTab] = useState<'screen' | 'window'>('screen');
  const [screens, setScreens] = useState<ScreenInfo[]>([]);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [loadingScreens, setLoadingScreens] = useState(false);
  const [loadingWindows, setLoadingWindows] = useState(false);
  const [selected, setSelected] = useState<{ type: 'screen' | 'window'; id: string } | null>(null);
  const [loadingThumbnails, setLoadingThumbnails] = useState<Set<string>>(new Set());

  // Fetch screens
  const fetchScreens = useCallback(async () => {
    setLoadingScreens(true);
    try {
      const res = await axios.post(`${OASIS_BASE_URL}/api/v1/dev-agent/execute`, {
        tool: 'computer_action',
        action: 'list_screens',
      }, { timeout: 30000 });
      if (res.data?.screens) {
        setScreens(res.data.screens);
        // Auto-select first screen if only one, or "all" if multiple
        if (res.data.screens.length === 1) {
          setSelected({ type: 'screen', id: '0' });
        }
      }
    } catch { /* dev-agent not available */ }
    setLoadingScreens(false);
  }, []);

  // Fetch a window thumbnail on demand
  const fetchWindowThumbnail = useCallback(async (appName: string) => {
    setLoadingThumbnails(prev => new Set(prev).add(appName));
    try {
      const res = await axios.post(`${OASIS_BASE_URL}/api/v1/dev-agent/execute`, {
        tool: 'computer_action',
        action: 'window_thumbnail',
        text: appName,
      }, { timeout: 20000 });
      if (res.data?.thumbnail) {
        setWindows(prev => prev.map(w =>
          w.app === appName ? { ...w, thumbnail: res.data.thumbnail } : w
        ));
      }
    } catch { /* ignore */ }
    setLoadingThumbnails(prev => { const n = new Set(prev); n.delete(appName); return n; });
  }, []);

  // Fetch windows, then auto-fetch thumbnails for the first batch
  const fetchWindows = useCallback(async () => {
    setLoadingWindows(true);
    try {
      const res = await axios.post(`${OASIS_BASE_URL}/api/v1/dev-agent/execute`, {
        tool: 'computer_action',
        action: 'list_windows',
      }, { timeout: 12000 });
      if (res.data?.windows) {
        const wins: WindowInfo[] = res.data.windows;
        setWindows(wins);
        // Auto-fetch thumbnails for the first 3 visible windows
        for (const w of wins.slice(0, 3)) {
          fetchWindowThumbnail(w.app);
        }
      }
    } catch { /* dev-agent not available */ }
    setLoadingWindows(false);
  }, [fetchWindowThumbnail]);

  // On open, fetch data
  useEffect(() => {
    if (open) {
      setSelected(null);
      setTab('screen');
      fetchScreens();
      fetchWindows();
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectScreen = (screenIdx: number | 'all') => {
    setSelected({ type: 'screen', id: String(screenIdx) });
  };

  const handleSelectWindow = (app: string) => {
    setSelected({ type: 'window', id: app });
    // Fetch thumbnail if we don't have one
    const w = windows.find(x => x.app === app);
    if (!w?.thumbnail && !loadingThumbnails.has(app)) {
      fetchWindowThumbnail(app);
    }
  };

  const handleConfirm = () => {
    if (!selected) return;
    if (selected.type === 'screen') {
      if (selected.id === 'all') {
        onSelect({ mode: 'full_screen', label: 'All Screens' });
      } else {
        const s = screens[parseInt(selected.id)];
        onSelect({
          mode: 'screen',
          target: selected.id,
          label: s?.name || `Screen ${parseInt(selected.id) + 1}`,
        });
      }
    } else {
      onSelect({ mode: 'window', target: selected.id, label: selected.id });
    }
  };

  if (!open) return null;

  const hasScreenPermission = screens.some(s => s.thumbnail && s.thumbnail.length > 0);

  // Portal to document.body to avoid stacking-context issues when rendered
  // inside framer-motion animated containers (transform/will-change traps fixed positioning).
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onCancel}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ duration: 0.2 }}
        className="w-[720px] max-w-[92vw] max-h-[85vh] rounded-2xl border border-slate-700 bg-[#0d1117] shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <h2 className="text-sm font-semibold text-slate-200">Choose what to share</h2>
          <Button variant="ghost" size="icon" onClick={onCancel} className="text-slate-400 hover:text-white w-7 h-7">
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-800">
          <button
            onClick={() => setTab('screen')}
            className={cn(
              'flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors border-b-2',
              tab === 'screen'
                ? 'text-blue-400 border-blue-500 bg-blue-950/10'
                : 'text-slate-400 border-transparent hover:text-slate-300',
            )}
          >
            <Monitor className="w-4 h-4" />
            Entire Screen
          </button>
          <button
            onClick={() => setTab('window')}
            className={cn(
              'flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors border-b-2',
              tab === 'window'
                ? 'text-blue-400 border-blue-500 bg-blue-950/10'
                : 'text-slate-400 border-transparent hover:text-slate-300',
            )}
          >
            <AppWindow className="w-4 h-4" />
            Window
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'screen' ? (
            /* ── Screen tab: show each display + "All screens" option ── */
            <div className="flex flex-col gap-4">
              {!hasScreenPermission && (
                <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-950/20 border border-amber-800/30">
                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div className="text-[11px] text-amber-300/80 leading-relaxed">
                    Screen Recording permission not granted. Previews unavailable but sharing still works.
                    <br />
                    <span className="text-amber-400/60">System Settings → Privacy & Security → Screen Recording → enable <strong>Oasis Screen Capture</strong></span>
                  </div>
                </div>
              )}

              {loadingScreens ? (
                <div className="flex items-center justify-center h-40">
                  <Loader2 className="w-6 h-6 text-slate-500 animate-spin" />
                </div>
              ) : (
                <div className={cn(
                  'grid gap-3',
                  screens.length >= 2 ? 'grid-cols-2' : 'grid-cols-1',
                  screens.length >= 2 && 'lg:grid-cols-3', // 3 cols if 3+ screens
                )}>
                  {/* All screens option (only if multiple) */}
                  {screens.length >= 2 && (
                    <button
                      onClick={() => handleSelectScreen('all')}
                      className={cn(
                        'relative rounded-xl border-2 overflow-hidden transition-all text-left',
                        selected?.type === 'screen' && selected.id === 'all'
                          ? 'border-blue-500 ring-2 ring-blue-500/20'
                          : 'border-slate-700/50 hover:border-slate-600',
                      )}
                    >
                      {/* Combined preview placeholder */}
                      <div className="flex items-center justify-center h-32 bg-slate-900/60">
                        <div className="flex items-center gap-1">
                          {screens.map((s) => (
                            <div key={s.index} className="w-12 h-8 rounded border border-slate-600 bg-slate-800 flex items-center justify-center">
                              <Monitor className="w-4 h-4 text-slate-500" />
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="px-3 py-2 bg-slate-900/80">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-medium text-slate-300">All Screens</span>
                          {selected?.type === 'screen' && selected.id === 'all' && (
                            <Check className="w-3.5 h-3.5 text-blue-400" />
                          )}
                        </div>
                        <span className="text-[9px] text-slate-500">
                          {screens.length} displays
                        </span>
                      </div>
                    </button>
                  )}

                  {/* Individual screens */}
                  {screens.map((s) => (
                    <button
                      key={s.index}
                      onClick={() => handleSelectScreen(s.index)}
                      className={cn(
                        'relative rounded-xl border-2 overflow-hidden transition-all text-left',
                        selected?.type === 'screen' && selected.id === String(s.index)
                          ? 'border-blue-500 ring-2 ring-blue-500/20'
                          : 'border-slate-700/50 hover:border-slate-600',
                      )}
                    >
                      {/* Thumbnail or placeholder */}
                      {s.thumbnail ? (
                        <img
                          src={`data:image/jpeg;base64,${s.thumbnail}`}
                          alt={s.name}
                          className="w-full h-32 object-cover bg-slate-900"
                        />
                      ) : (
                        <div className="flex items-center justify-center h-32 bg-slate-900/60">
                          <Monitor className="w-10 h-10 text-slate-700" />
                        </div>
                      )}
                      <div className="px-3 py-2 bg-slate-900/80">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-medium text-slate-300 truncate">{s.name}</span>
                          {selected?.type === 'screen' && selected.id === String(s.index) && (
                            <Check className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                          )}
                        </div>
                        <span className="text-[9px] text-slate-500">
                          {s.width} x {s.height}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            /* ── Window tab: list visible apps with thumbnails ── */
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-slate-500">
                  {windows.length} app{windows.length !== 1 ? 's' : ''} running
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={fetchWindows}
                  disabled={loadingWindows}
                  className="text-slate-400 hover:text-white text-[10px] h-6 px-2 gap-1"
                >
                  {loadingWindows ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  Refresh
                </Button>
              </div>

              {loadingWindows && !windows.length ? (
                <div className="flex items-center justify-center h-32">
                  <Loader2 className="w-5 h-5 text-slate-500 animate-spin" />
                </div>
              ) : (
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                  {windows.map((w) => {
                    const isSelected = selected?.type === 'window' && selected.id === w.app;
                    const isLoadingThumb = loadingThumbnails.has(w.app);
                    return (
                      <button
                        key={w.app}
                        onClick={() => handleSelectWindow(w.app)}
                        className={cn(
                          'relative rounded-xl border-2 overflow-hidden transition-all text-left',
                          isSelected
                            ? 'border-blue-500 ring-2 ring-blue-500/20'
                            : 'border-slate-700/50 hover:border-slate-600',
                        )}
                      >
                        {/* Thumbnail → Icon fallback → Generic placeholder */}
                        {(w.thumbnail || w.icon) ? (
                          <img
                            src={`data:image/jpeg;base64,${w.thumbnail || w.icon}`}
                            alt={w.app}
                            className={cn(
                              'bg-slate-900',
                              w.thumbnail
                                ? 'w-full h-28 object-cover'
                                : 'w-16 h-16 object-contain mx-auto my-6',
                            )}
                          />
                        ) : (
                          <div className="flex items-center justify-center h-28 bg-slate-900/60">
                            {isLoadingThumb ? (
                              <Loader2 className="w-5 h-5 text-slate-600 animate-spin" />
                            ) : (
                              <AppWindow className="w-8 h-8 text-slate-700" />
                            )}
                          </div>
                        )}
                        <div className="px-3 py-2 bg-slate-900/80">
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-[11px] font-medium text-slate-300 truncate">{w.app}</span>
                            {isSelected && (
                              <Check className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-800 bg-slate-900/50">
          <span className="text-[11px] text-slate-500">
            {selected
              ? selected.type === 'screen'
                ? selected.id === 'all'
                  ? `Sharing all ${screens.length} screens`
                  : `Sharing ${screens[parseInt(selected.id)]?.name || `Screen ${parseInt(selected.id) + 1}`}`
                : `Sharing ${selected.id}`
              : 'Select what to share'
            }
          </span>
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancel}
              className="text-slate-400 hover:text-white"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleConfirm}
              disabled={!selected}
              className="bg-blue-600 hover:bg-blue-500 text-white gap-1.5 px-5"
            >
              <Check className="w-3.5 h-3.5" />
              Share
            </Button>
          </div>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
