import { useEffect, useRef } from 'react';
import { FileText, FileAudio, FileVideo, Image } from 'lucide-react';
import type { Artifact } from '@/lib/artifact-api';
import { cn } from '@/lib/utils';

interface ArtifactMentionDropdownProps {
  artifacts: Artifact[];
  selectedIndex: number;
  onSelect: (artifact: Artifact) => void;
  onHover: (index: number) => void;
}

function getArtifactIcon(mimeType: string) {
  if (mimeType.startsWith('audio/')) return FileAudio;
  if (mimeType.startsWith('video/')) return FileVideo;
  if (mimeType.startsWith('image/')) return Image;
  return FileText;
}

function getFileTypeLabel(mimeType: string): string {
  if (mimeType.startsWith('audio/')) return 'Audio';
  if (mimeType.startsWith('video/')) return 'Video';
  if (mimeType.startsWith('image/')) return 'Image';
  if (mimeType.includes('pdf')) return 'PDF';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'Document';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'Spreadsheet';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'Slides';
  if (mimeType.startsWith('text/')) return 'Text';
  return 'File';
}

export function ArtifactMentionDropdown({
  artifacts,
  selectedIndex,
  onSelect,
  onHover,
}: ArtifactMentionDropdownProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const item = container.children[selectedIndex] as HTMLElement | undefined;
    if (item) {
      item.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (artifacts.length === 0) {
    return (
      <div className="absolute bottom-full left-0 right-0 mb-1 z-50 rounded-lg bg-slate-800/95 border border-slate-700 backdrop-blur-sm shadow-xl p-3">
        <p className="text-xs text-slate-500 text-center">No matching artifacts</p>
      </div>
    );
  }

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 z-50 rounded-lg bg-slate-800/95 border border-slate-700 backdrop-blur-sm shadow-xl overflow-hidden">
      <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
        {artifacts.map((artifact, index) => {
          const Icon = getArtifactIcon(artifact.mime_type);
          return (
            <button
              key={artifact.artifact_id}
              type="button"
              className={cn(
                'w-full flex items-center gap-2 py-1.5 px-2 text-left transition-colors',
                index === selectedIndex
                  ? 'bg-blue-600/30 text-white'
                  : 'text-slate-300 hover:bg-slate-700/50',
              )}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(e) => {
                e.preventDefault(); // prevent textarea blur
                onSelect(artifact);
              }}
            >
              <Icon className="w-3.5 h-3.5 flex-shrink-0 text-slate-400" />
              <span className="text-xs font-medium truncate flex-1">{artifact.name}</span>
              <span className="text-[10px] text-slate-500 flex-shrink-0">
                {getFileTypeLabel(artifact.mime_type)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
