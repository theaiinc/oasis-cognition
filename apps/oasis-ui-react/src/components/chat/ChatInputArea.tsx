import { useState, useRef, useCallback } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { Send, Reply, Paperclip, X, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useArtifactMention } from '@/hooks/useArtifactMention';
import { ArtifactMentionDropdown } from './ArtifactMentionDropdown';
import type { PendingFile } from '@/hooks/useQuickUpload';

const ACCEPTED_FILE_TYPES = [
  // Documents
  '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.tsv,.rtf,.odt,.ods,.odp',
  // Audio
  '.mp3,.wav,.m4a,.ogg,.flac,.aac,.wma,.webm',
  // Video
  '.mp4,.mkv,.avi,.mov,.wmv,.webm',
  // Images
  '.png,.jpg,.jpeg,.gif,.bmp,.webp,.svg,.tiff',
].join(',');

interface ChatInputAreaProps {
  inputText: string;
  setInputText: (v: string) => void;
  onSend: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  replyToMessageText: string | null;
  onCancelReply: () => void;
  micEnabled: boolean;
  children?: React.ReactNode;
  activeProjectId?: string;
  pendingFiles?: PendingFile[];
  onFileAdd?: (files: File[]) => void;
  onFileRemove?: (id: string) => void;
}

export function ChatInputArea({
  inputText,
  setInputText,
  onSend,
  inputRef,
  replyToMessageText,
  onCancelReply,
  micEnabled,
  children,
  activeProjectId,
  pendingFiles = [],
  onFileAdd,
  onFileRemove,
}: ChatInputAreaProps) {
  const [cursorPosition, setCursorPosition] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateCursorPosition = useCallback(() => {
    if (inputRef.current) {
      setCursorPosition(inputRef.current.selectionStart ?? 0);
    }
  }, [inputRef]);

  const mention = useArtifactMention({
    inputText,
    cursorPosition,
    activeProjectId,
  });

  const handleMentionSelect = useCallback(
    (artifact: Parameters<typeof mention.insertMention>[0]) => {
      const { newText, newCursorPos } = mention.insertMention(artifact);
      setInputText(newText);
      setCursorPosition(newCursorPos);
      // Set cursor position in textarea after React re-render
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.selectionStart = newCursorPos;
          inputRef.current.selectionEnd = newCursorPos;
          inputRef.current.focus();
        }
      });
    },
    [mention, setInputText, inputRef],
  );

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0 && onFileAdd) {
        onFileAdd(Array.from(files));
      }
      // Reset so the same file can be selected again
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [onFileAdd],
  );

  return (
    <div className="mt-4 pt-2">
      <AnimatePresence>
        {micEnabled && children}
      </AnimatePresence>
      <AnimatePresence>
        {replyToMessageText && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-900/20 border border-blue-800/30">
            <Reply className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
            <span className="text-[11px] text-slate-300 flex-1 truncate">Replying to: {replyToMessageText.slice(0, 80)}{replyToMessageText.length > 80 ? '...' : ''}</span>
            <button type="button" onClick={onCancelReply} className="text-[10px] text-slate-500 hover:text-slate-300">Cancel</button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Pending file chips */}
      {pendingFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {pendingFiles.map((pf) => (
            <div
              key={pf.id}
              className={cn(
                'inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs border',
                pf.error
                  ? 'bg-red-900/20 border-red-800/40 text-red-300'
                  : pf.uploading
                    ? 'bg-slate-800/60 border-slate-700/50 text-slate-300'
                    : 'bg-emerald-900/20 border-emerald-800/40 text-emerald-300',
              )}
            >
              {pf.uploading && <Loader2 className="w-3 h-3 animate-spin" />}
              {!pf.uploading && !pf.error && <CheckCircle2 className="w-3 h-3" />}
              {pf.error && <AlertCircle className="w-3 h-3" />}
              <span className="truncate max-w-[120px]">{pf.name}</span>
              {onFileRemove && (
                <button
                  type="button"
                  onClick={() => onFileRemove(pf.id)}
                  className="ml-0.5 text-slate-500 hover:text-slate-300"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="relative group">
        {/* Mention dropdown */}
        {mention.showDropdown && (
          <ArtifactMentionDropdown
            artifacts={mention.filteredArtifacts}
            selectedIndex={mention.selectedIndex}
            onSelect={handleMentionSelect}
            onHover={mention.setSelectedIndex}
          />
        )}

        <textarea
          ref={inputRef}
          value={inputText}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
            setInputText(e.target.value);
            setCursorPosition(e.target.selectionStart ?? 0);
            const el = e.target;
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 200) + 'px';
          }}
          onClick={updateCursorPosition}
          onKeyUp={updateCursorPosition}
          placeholder="Ask Oasis anything... (@ to mention artifacts)"
          onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
            // Let mention dropdown handle keys first
            if (mention.showDropdown) {
              const consumed = mention.handleKeyDown(e);
              if (consumed) {
                // If Enter or Tab was pressed, also insert the mention
                if ((e.key === 'Enter' || e.key === 'Tab') && mention.filteredArtifacts[mention.selectedIndex]) {
                  handleMentionSelect(mention.filteredArtifacts[mention.selectedIndex]);
                }
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
              requestAnimationFrame(() => { (e.target as HTMLTextAreaElement).style.height = 'auto'; });
            }
          }}
          rows={1}
          className={cn(
            "pl-4 pr-24 py-3.5 bg-slate-900/60 border border-slate-700/50 rounded-2xl text-sm text-slate-100 placeholder:text-slate-500",
            "focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all backdrop-blur-sm w-full resize-none leading-relaxed shadow-lg shadow-black/20"
          )}
          style={{ minHeight: '48px', maxHeight: '200px' }}
        />

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_FILE_TYPES}
          onChange={handleFileChange}
          className="hidden"
        />

        <div className="absolute right-2 bottom-2 flex items-center gap-1">
          {onFileAdd && (
            <Button
              onClick={handleFileSelect}
              size="icon"
              variant="ghost"
              className="h-9 w-9 rounded-xl text-slate-400 hover:text-white hover:bg-slate-700/40 transition-all"
              title="Attach file"
            >
              <Paperclip className="w-4 h-4" />
            </Button>
          )}
          <Button
            onClick={() => { onSend(); inputRef.current && (inputRef.current.style.height = 'auto'); }}
            size="icon"
            variant="ghost"
            className="h-9 w-9 rounded-xl text-slate-400 hover:text-white hover:bg-blue-600/20 transition-all disabled:opacity-30"
            disabled={!inputText.trim()}
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
