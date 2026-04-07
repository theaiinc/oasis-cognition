import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, RefreshCw, Loader2,
  Upload, Youtube, Search, Trash2, Play, FileText, FileAudio, FileVideo,
  FileImage, File, ChevronDown, RotateCcw,
  Link2, Unlink, BookOpen,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import ReactMarkdown from 'react-markdown';
import { LanguageSelector, getSelectedLanguage, setSelectedLanguage } from '@/components/ui/language-selector';
import {
  uploadArtifact, uploadYoutube, listArtifacts, deleteArtifact,
  processArtifact, summarizeArtifact, searchArtifacts, getArtifactDownloadUrl,
  getProject,
  linkArtifactToProject, unlinkArtifactFromProject, subscribeToArtifactEvents,
  type Artifact, type Project, type SearchResult, type ArtifactSSEEvent,
} from '@/lib/artifact-api';

// ── Props ─────────────────────────────────────────────────────────────

interface ArtifactsPanelProps {
  open: boolean;
  onClose: () => void;
  activeProjectId?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────

const AUDIO_EXTS = ['.m4a', '.mp3', '.wav', '.ogg', '.aac', '.flac', '.wma', '.webm'];
const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'];

function inferMediaType(mime: string, name: string): 'audio' | 'video' | 'image' | null {
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  const ext = name.toLowerCase().replace(/.*(\.[^.]+)$/, '$1');
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  return null;
}

const MIME_ICONS: Record<string, typeof FileText> = {
  'audio/': FileAudio, 'video/': FileVideo, 'image/': FileImage,
  'application/pdf': FileText, 'text/': FileText,
};

function getIcon(mime: string, name?: string) {
  for (const [prefix, Icon] of Object.entries(MIME_ICONS)) {
    if (mime.startsWith(prefix)) return Icon;
  }
  if (name) {
    const media = inferMediaType(mime, name);
    if (media === 'audio') return FileAudio;
    if (media === 'video') return FileVideo;
    if (media === 'image') return FileImage;
  }
  return File;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-600/20 text-yellow-400',
  queued: 'bg-orange-600/20 text-orange-400',
  processing: 'bg-blue-600/20 text-blue-400',
  ready: 'bg-green-600/20 text-green-400',
  error: 'bg-red-600/20 text-red-400',
};

// ── Component ─────────────────────────────────────────────────────────

export function ArtifactsPanel({ open, onClose, activeProjectId }: ArtifactsPanelProps) {
  // ── Artifacts state ─────────────────────────────────────────────────
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [showYoutubeInput, setShowYoutubeInput] = useState(false);
  const [artifactLanguage, setArtifactLanguage] = useState(() => getSelectedLanguage());
  const [expandedArtifact, setExpandedArtifact] = useState<string | null>(null);
  const [showAllArtifacts, setShowAllArtifacts] = useState(false);
  const [summarizingIds, setSummarizingIds] = useState<Set<string>>(new Set());
  const [summarizePrompt, setSummarizePrompt] = useState<{ id: string; name: string } | null>(null);
  const [summarizeInstructions, setSummarizeInstructions] = useState('');
  const [transcriptDialog, setTranscriptDialog] = useState<{ name: string; text: string; title: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [queuePositions, setQueuePositions] = useState<Map<string, number>>(new Map());
  const [currentProcessing, setCurrentProcessing] = useState<string | null>(null);
  const [summarizeLang, setSummarizeLang] = useState('');

  // ── Active project detail (needed for link/unlink status) ───────────
  const [activeProjectDetail, setActiveProjectDetail] = useState<Project | null>(null);

  const refreshActiveProject = useCallback(async () => {
    if (!activeProjectId) { setActiveProjectDetail(null); setShowAllArtifacts(false); return; }
    try { setActiveProjectDetail(await getProject(activeProjectId)); } catch { setActiveProjectDetail(null); }
  }, [activeProjectId]);

  // ── Data loading ────────────────────────────────────────────────────

  const refreshArtifacts = useCallback(async (showLoading = false) => {
    if (showLoading) setArtifactsLoading(true);
    try {
      const fresh = await listArtifacts(); // always fetch all — filter in UI
      setArtifacts(prev => {
        // Merge: update changed fields without replacing objects that haven't changed
        // This prevents re-rendering media players
        if (prev.length !== fresh.length) return fresh;
        const prevMap = new Map(prev.map(a => [a.artifact_id, a]));
        let changed = false;
        const merged = fresh.map(f => {
          const p = prevMap.get(f.artifact_id);
          if (!p) { changed = true; return f; }
          if (p.status !== f.status || p.transcript !== f.transcript || p.summary !== f.summary || p.name !== f.name) {
            changed = true;
            return f;
          }
          return p; // keep same reference
        });
        return changed ? merged : prev;
      });
      // Clear processingIds for artifacts that finished
      setProcessingIds(prev => {
        const done = fresh.filter(a => a.status === 'ready' || a.status === 'error' || a.status === 'pending');
        const doneIds = new Set(done.map(a => a.artifact_id));
        const next = new Set([...prev].filter(id => !doneIds.has(id)));
        return next.size !== prev.size ? next : prev;
      });
    } catch { /* ignore */ }
    if (showLoading) setArtifactsLoading(false);
  }, [activeProjectId]);

  useEffect(() => {
    if (open) {
      refreshArtifacts(true);
      if (activeProjectId) refreshActiveProject();
    }
  }, [open, refreshArtifacts, activeProjectId, refreshActiveProject]);

  // SSE: Real-time artifact status updates
  useEffect(() => {
    if (!open) return;

    const cleanup = subscribeToArtifactEvents(
      (evt: ArtifactSSEEvent) => {
        if (evt.event === 'snapshot') {
          setCurrentProcessing(evt.current_processing ?? null);
          if (evt.queue?.length) {
            const pos = new Map<string, number>();
            evt.queue.forEach((id, i) => pos.set(id, i + 1));
            setQueuePositions(pos);
          } else {
            setQueuePositions(new Map());
          }
          if (evt.current_processing || evt.queue?.length) {
            refreshArtifacts();
          }
        } else if (evt.event === 'status' && evt.artifact_id) {
          const aid = evt.artifact_id;
          const status = evt.status as Artifact['status'];

          setArtifacts(prev => prev.map(a =>
            a.artifact_id === aid ? { ...a, status } : a
          ));

          if (status === 'processing') {
            setCurrentProcessing(aid);
            setQueuePositions(prev => {
              const next = new Map(prev);
              next.delete(aid);
              for (const [id, pos] of next) {
                if (pos > 1) next.set(id, pos - 1);
              }
              return next;
            });
          } else if (status === 'queued' && evt.position) {
            setQueuePositions(prev => new Map(prev).set(aid, evt.position!));
          } else if (status === 'ready' || status === 'error') {
            setCurrentProcessing(prev => prev === aid ? null : prev);
            setQueuePositions(prev => {
              const next = new Map(prev);
              next.delete(aid);
              return next;
            });
            setProcessingIds(prev => {
              const next = new Set(prev);
              next.delete(aid);
              return next;
            });
            refreshArtifacts();
          }
        }
      },
      () => {
        setTimeout(() => refreshArtifacts(), 2000);
      },
    );

    return cleanup;
  }, [open, refreshArtifacts]);

  // ── Artifact handlers ───────────────────────────────────────────────

  const handleUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      const results = [];
      for (const file of Array.from(files)) {
        const result = await uploadArtifact(file, { language: artifactLanguage || undefined, project_id: activeProjectId });
        results.push(result);
      }
      await refreshArtifacts();
      if (activeProjectId) await refreshActiveProject();
      const newIds = new Set(processingIds);
      for (const r of results) {
        const id = r?.artifact_id;
        if (id) newIds.add(id);
      }
      if (newIds.size > processingIds.size) setProcessingIds(newIds);
    } catch (err: any) { console.error('Upload failed:', err); }
    setUploading(false);
  };

  const handleYoutube = async () => {
    if (!youtubeUrl.trim()) return;
    setUploading(true);
    try {
      const result = await uploadYoutube(youtubeUrl, { language: artifactLanguage || undefined, project_id: activeProjectId });
      setYoutubeUrl(''); setShowYoutubeInput(false);
      await refreshArtifacts();
      if (activeProjectId) await refreshActiveProject();
      const id = result?.artifact_id;
      if (id) setProcessingIds(prev => new Set(prev).add(id));
    } catch (err: any) { console.error('YouTube download failed:', err); }
    setUploading(false);
  };

  const handleProcess = async (id: string) => {
    setProcessingIds(prev => new Set(prev).add(id));
    try { await processArtifact(id); await refreshArtifacts(); }
    catch (err: any) { console.error('Processing failed:', err); }
  };

  const handleSummarizeStart = (id: string) => {
    const art = artifacts.find(a => a.artifact_id === id);
    setSummarizePrompt({ id, name: art?.name || 'Artifact' });
    setSummarizeInstructions('');
    setSummarizeLang(art?.language || artifactLanguage || '');
  };

  const handleSummarizeConfirm = async () => {
    if (!summarizePrompt) return;
    const { id, name } = summarizePrompt;
    setSummarizePrompt(null);
    setSummarizingIds(prev => new Set(prev).add(id));
    try {
      const data = await summarizeArtifact(id, {
        language: summarizeLang,
        instructions: summarizeInstructions || undefined,
      });
      await refreshArtifacts();
      setTranscriptDialog({ name, text: data.summary, title: 'Summary' });
    } catch (err: any) { console.error('Summarize failed:', err); }
    setSummarizingIds(prev => { const s = new Set(prev); s.delete(id); return s; });
  };

  const handleDeleteArtifact = async (id: string) => {
    try { await deleteArtifact(id); setArtifacts(prev => prev.filter(a => a.artifact_id !== id)); } catch { /* ignore */ }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) { setSearchResults(null); return; }
    setSearching(true);
    try { setSearchResults(await searchArtifacts(searchQuery, { project_id: activeProjectId })); }
    catch { setSearchResults([]); }
    setSearching(false);
  };

  const handleToggleLinkArtifact = async (artifactId: string) => {
    if (!activeProjectId) return;
    const isLinked = activeProjectDetail?.artifacts?.some((a: any) => a.artifact_id === artifactId);
    if (isLinked) {
      await unlinkArtifactFromProject(activeProjectId, artifactId);
    } else {
      await linkArtifactToProject(activeProjectId, artifactId);
    }
    await refreshActiveProject();
  };

  if (!open) return null;

  const activeProjectName = activeProjectDetail?.name;

  return (<>
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 400, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="border-r border-slate-800 bg-[#0a0f1a] overflow-hidden flex flex-col"
    >
      {/* Header */}
      <div className="p-4 border-b border-slate-800 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-300">Artifacts</h2>
        <Button variant="ghost" size="icon" className="w-6 h-6 text-slate-500 hover:text-white" onClick={onClose}>
          <X className="w-4 h-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4">
          <div className="flex flex-col gap-3">
            {/* Active project indicator */}
            {activeProjectId && (
              <div className="flex items-center justify-between px-2 py-1.5 rounded bg-blue-900/10 border border-blue-800/20">
                <span className="text-[10px] text-blue-400">{activeProjectName || 'Project'}: {showAllArtifacts ? 'all artifacts' : 'linked only'}</span>
                <Button variant="ghost" size="sm" className="text-[10px] h-5" onClick={() => setShowAllArtifacts(!showAllArtifacts)}>
                  {showAllArtifacts ? 'Linked only' : 'Show all'}
                </Button>
              </div>
            )}

            {/* Upload bar */}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="flex-1 text-xs" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                {uploading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Upload className="h-3 w-3 mr-1" />}
                Upload Files
              </Button>
              <Button variant="outline" size="sm" className="text-xs" onClick={() => setShowYoutubeInput(!showYoutubeInput)} disabled={uploading}>
                <Youtube className="h-3 w-3 mr-1" /> YouTube
              </Button>
              <input ref={fileInputRef} type="file" multiple accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.rtf,.txt,.m4a,.wav,.mp3,.mp4,.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,audio/*,video/*,image/*" className="hidden" onChange={e => handleUpload(e.target.files)} />
            </div>

            <AnimatePresence>
              {showYoutubeInput && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="flex gap-2 overflow-hidden">
                  <Input placeholder="YouTube URL..." value={youtubeUrl} onChange={e => setYoutubeUrl(e.target.value)} className="text-xs h-8" onKeyDown={e => e.key === 'Enter' && handleYoutube()} />
                  <Button variant="default" size="sm" className="text-xs h-8" onClick={handleYoutube} disabled={uploading}>Add</Button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Language selector */}
            <LanguageSelector
              value={artifactLanguage}
              onChange={(code) => { setArtifactLanguage(code); setSelectedLanguage(code); }}
              placeholder="Language — blank for auto-detect"
            />

            {/* Search */}
            <div className="flex gap-2">
              <Input placeholder="Semantic search across artifacts..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="text-xs h-8" onKeyDown={e => e.key === 'Enter' && handleSearch()} />
              <Button variant="ghost" size="sm" className="h-8" onClick={handleSearch} disabled={searching}>
                {searching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
              </Button>
            </div>

            {/* Search results */}
            {searchResults !== null && (
              <div className="border border-slate-800 rounded-lg p-2">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-slate-400">{searchResults.length} results</span>
                  <Button variant="ghost" size="sm" className="text-xs h-6" onClick={() => setSearchResults(null)}>Clear</Button>
                </div>
                {searchResults.map((r, i) => (
                  <div key={i} className="p-2 mb-1 rounded bg-slate-800/40 text-xs">
                    <div className="flex justify-between text-slate-400 mb-1">
                      <span className="font-medium text-slate-300">{r.artifact_name}</span>
                      <span>{(r.similarity * 100).toFixed(0)}%</span>
                    </div>
                    <p className="text-slate-500 line-clamp-3">{r.chunk_text}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Artifact list */}
            {artifactsLoading && <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-slate-500" /></div>}
            {!artifactsLoading && artifacts.length === 0 && (
              <p className="text-xs text-slate-500 text-center py-6">No artifacts yet. Upload files or add a YouTube video.</p>
            )}
            {(() => {
              const linkedIds = new Set((activeProjectDetail?.artifacts || []).map((pa: any) => pa.artifact_id));
              let filtered = artifacts;
              if (activeProjectId && !showAllArtifacts) {
                filtered = artifacts.filter(a => linkedIds.has(a.artifact_id));
              }
              if (activeProjectId && showAllArtifacts) {
                filtered = [...filtered].sort((a, b) => (linkedIds.has(b.artifact_id) ? 1 : 0) - (linkedIds.has(a.artifact_id) ? 1 : 0));
              }
              return filtered;
            })().map(a => {
              const mediaType = inferMediaType(a.mime_type, a.name);
              const Icon = getIcon(a.mime_type, a.name);
              const isExpanded = expandedArtifact === a.artifact_id;
              const isProcessing = processingIds.has(a.artifact_id) || a.status === 'processing';
              const isQueued = a.status === 'queued';
              const queuePos = queuePositions.get(a.artifact_id);
              const isLinkedToProject = activeProjectId && activeProjectDetail?.artifacts?.some((pa: any) => pa.artifact_id === a.artifact_id);
              return (
                <div key={a.artifact_id} className={cn("rounded-lg border bg-slate-900/50 hover:bg-slate-800/40 transition-colors group", isLinkedToProject ? "border-blue-800/40" : "border-slate-800")}>
                  <div className="flex items-center gap-2 p-2.5 cursor-pointer" onClick={() => setExpandedArtifact(isExpanded ? null : a.artifact_id)}>
                    <Icon className="h-4 w-4 text-slate-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-slate-200 truncate">{a.name}</p>
                      <p className="text-[10px] text-slate-500">{formatSize(a.file_size)} &middot; {a.mime_type.split('/')[1]}</p>
                    </div>
                    <Badge className={cn('text-[10px] px-1.5 py-0 flex items-center gap-1', STATUS_COLORS[a.status] || '')}>
                      {isProcessing && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                      {isQueued && queuePos ? `queued #${queuePos}` : a.status}
                    </Badge>
                    {a.source_type === 'youtube' && <Youtube className="h-3 w-3 text-red-400" />}
                    <button className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 text-red-400/70 hover:text-red-400" onClick={e => { e.stopPropagation(); handleDeleteArtifact(a.artifact_id); }} title="Delete artifact">
                      <Trash2 className="h-3 w-3" />
                    </button>
                    <ChevronDown className={cn('h-3 w-3 text-slate-500 transition-transform', isExpanded && 'rotate-180')} />
                  </div>
                  {isExpanded && (
                      <div className="border-t border-slate-800">
                        <div className="p-2.5 flex flex-col gap-2">
                          {/* Media player */}
                          {mediaType === 'audio' && (
                            <audio key={`audio-${a.artifact_id}`} controls className="w-full h-8" preload="metadata">
                              <source src={getArtifactDownloadUrl(a.artifact_id)} />
                            </audio>
                          )}
                          {mediaType === 'video' && (
                            <video key={`video-${a.artifact_id}`} controls className="w-full rounded max-h-48" preload="metadata">
                              <source src={getArtifactDownloadUrl(a.artifact_id)} />
                            </video>
                          )}
                          {mediaType === 'image' && (
                            <img key={`img-${a.artifact_id}`} src={getArtifactDownloadUrl(a.artifact_id)} alt={a.name} className="w-full rounded max-h-48 object-contain" />
                          )}

                          {/* Content / Transcript */}
                          {a.transcript && (() => {
                            const contentLabel = (mediaType === 'audio' || mediaType === 'video') ? 'Transcript' : 'Content';
                            return (
                              <div>
                                <div className="flex items-center justify-between mb-1">
                                  <h5 className="text-[10px] text-slate-500 uppercase">{contentLabel}</h5>
                                  <button
                                    className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
                                    onClick={e => { e.stopPropagation(); setTranscriptDialog({ name: a.name, text: a.transcript!, title: contentLabel }); }}
                                  >
                                    View full
                                  </button>
                                </div>
                                <ScrollArea className="max-h-28">
                                  <div className="text-[11px] text-slate-300 leading-relaxed bg-slate-950/50 rounded p-2 whitespace-pre-wrap">
                                    {a.transcript}
                                  </div>
                                </ScrollArea>
                              </div>
                            );
                          })()}

                          {a.source_url && <p className="text-[10px] text-blue-400 truncate">{a.source_url}</p>}
                          <div className="flex gap-1.5">
                            {(a.status === 'pending' || a.status === 'error') && (
                              <Button variant="outline" size="sm" className="text-[10px] h-6" onClick={e => { e.stopPropagation(); handleProcess(a.artifact_id); }} disabled={isProcessing || isQueued}>
                                {isProcessing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Play className="h-3 w-3 mr-1" />} Process
                              </Button>
                            )}
                            {a.status === 'ready' && (
                              <Button variant="outline" size="sm" className="text-[10px] h-6" onClick={e => { e.stopPropagation(); handleProcess(a.artifact_id); }} disabled={isProcessing}>
                                {isProcessing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RotateCcw className="h-3 w-3 mr-1" />} Reprocess
                              </Button>
                            )}
                            {a.status === 'ready' && a.transcript && (
                              a.summary ? (
                                <div className="flex items-center gap-0.5">
                                  <Button variant="outline" size="sm" className="text-[10px] h-6 rounded-r-none" onClick={e => { e.stopPropagation(); setTranscriptDialog({ name: a.name, text: a.summary!, title: 'Summary' }); }}>
                                    <BookOpen className="h-3 w-3 mr-1" /> Summary
                                  </Button>
                                  <Button variant="outline" size="sm" className="text-[10px] h-6 px-1.5 rounded-l-none border-l-0" onClick={e => { e.stopPropagation(); handleSummarizeStart(a.artifact_id); }} disabled={summarizingIds.has(a.artifact_id)} title="Re-summarize">
                                    {summarizingIds.has(a.artifact_id) ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-2.5 w-2.5" />}
                                  </Button>
                                </div>
                              ) : (
                                <Button variant="outline" size="sm" className="text-[10px] h-6" onClick={e => { e.stopPropagation(); handleSummarizeStart(a.artifact_id); }} disabled={summarizingIds.has(a.artifact_id)}>
                                  {summarizingIds.has(a.artifact_id) ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <FileText className="h-3 w-3 mr-1" />} Summarize
                                </Button>
                              )
                            )}
                            {activeProjectId && (
                              <Button
                                variant="ghost" size="sm"
                                className={cn("text-[10px] h-6", activeProjectDetail?.artifacts?.some((pa: any) => pa.artifact_id === a.artifact_id) ? "text-blue-400 hover:text-blue-300" : "text-slate-500 hover:text-slate-300")}
                                onClick={e => { e.stopPropagation(); handleToggleLinkArtifact(a.artifact_id); }}
                                title={activeProjectDetail?.artifacts?.some((pa: any) => pa.artifact_id === a.artifact_id) ? `Unlink from ${activeProjectName}` : `Link to ${activeProjectName}`}
                              >
                                {activeProjectDetail?.artifacts?.some((pa: any) => pa.artifact_id === a.artifact_id) ? <><Unlink className="h-3 w-3 mr-1" /> Unlink</> : <><Link2 className="h-3 w-3 mr-1" /> Link</>}
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </ScrollArea>
    </motion.div>

    {/* Summarize prompt dialog */}
    {summarizePrompt && (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setSummarizePrompt(null)}>
        <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-[90vw] max-w-md flex flex-col" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
            <h3 className="text-sm font-medium text-slate-200">Summarize — {summarizePrompt.name}</h3>
            <button onClick={() => setSummarizePrompt(null)} className="text-slate-400 hover:text-slate-200"><X className="h-4 w-4" /></button>
          </div>
          <div className="p-4 space-y-3">
            <div>
              <label className="text-[10px] text-slate-500 uppercase block mb-1">Summary language</label>
              <LanguageSelector
                value={summarizeLang}
                onChange={(code) => { setSummarizeLang(code); setArtifactLanguage(code); setSelectedLanguage(code); }}
                placeholder="Auto-detect"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-500 uppercase block mb-1">Instructions (optional)</label>
              <textarea
                className="w-full text-xs bg-slate-950 border border-slate-700 rounded p-2 text-slate-300 placeholder:text-slate-600 resize-none focus:outline-none focus:border-slate-500"
                rows={3}
                placeholder="e.g. Focus on action items, highlight key decisions, include participant names..."
                value={summarizeInstructions}
                onChange={e => setSummarizeInstructions(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSummarizeConfirm(); }}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" className="text-[10px] h-7" onClick={() => setSummarizePrompt(null)}>Cancel</Button>
              <Button variant="outline" size="sm" className="text-[10px] h-7" onClick={handleSummarizeConfirm}>
                <FileText className="h-3 w-3 mr-1" /> Summarize
              </Button>
            </div>
          </div>
        </div>
      </div>
    )}

    {/* Full transcript dialog */}
    {transcriptDialog && (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setTranscriptDialog(null)}>
        <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-[90vw] max-w-2xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 shrink-0">
            <h3 className="text-sm font-medium text-slate-200 truncate">{transcriptDialog.title} — {transcriptDialog.name}</h3>
            <button onClick={() => setTranscriptDialog(null)} className="text-slate-400 hover:text-slate-200 transition-colors">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-4">
            {transcriptDialog.title === 'Summary' ? (
              <div className="text-xs text-slate-300 leading-relaxed prose prose-invert prose-xs max-w-none prose-headings:text-slate-200 prose-p:text-slate-300 prose-strong:text-slate-200 prose-li:text-slate-300 prose-a:text-blue-400">
                <ReactMarkdown>{transcriptDialog.text}</ReactMarkdown>
              </div>
            ) : (
              <div className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap font-mono">
                {transcriptDialog.text}
              </div>
            )}
          </div>
        </div>
      </div>
    )}
  </>);
}
