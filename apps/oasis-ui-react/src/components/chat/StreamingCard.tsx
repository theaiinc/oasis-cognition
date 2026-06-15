import { type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { useAutoScroll } from '@/hooks/useAutoScroll';
import { MarkdownMessage } from './MarkdownMessage';

export type StreamingCardVariant = 'thinking' | 'assistant' | 'user' | 'minimal';

export interface StreamingCardProps {
  variant: StreamingCardVariant;
  /** Markdown-rendered streaming content. */
  content?: string;
  /** Show animated "streaming" indicator in header. */
  streaming?: boolean;
  /** Enable auto-scroll-to-bottom. Default true. */
  autoScroll?: boolean;
  /** If set, card is scrollable (e.g. '340px'). */
  maxHeight?: string;
  /** Sticky header slot (variant default if omitted). */
  header?: ReactNode;
  /** Footer slot. */
  footer?: ReactNode;
  /** Content below the streamed text (tool calls, activity). */
  children?: ReactNode;
  /** If set, show elapsed timer in header (seconds). */
  elapsedMs?: number;
  /** Stop button for thinking variant. */
  onStop?: () => void;
  /** Callback for clickable option buttons in markdown (assistant variant). */
  onOptionClick?: (option: string) => void;
  className?: string;
}

/** Animated dots using CSS opacity-stagger animation. */
function AnimatedDots() {
  return (
    <span className="inline-flex items-center gap-[1px]">
      <span className="w-1 h-1 rounded-full bg-amber-400/80 animate-bounce [animation-delay:0ms]" />
      <span className="w-1 h-1 rounded-full bg-amber-400/80 animate-bounce [animation-delay:150ms]" />
      <span className="w-1 h-1 rounded-full bg-amber-400/80 animate-bounce [animation-delay:300ms]" />
    </span>
  );
}

const markdownComponents = {
  p: ({ children }: { children: ReactNode }) => <p className="mb-1 last:mb-0">{children}</p>,
  strong: ({ children }: { children: ReactNode }) => <strong className="font-semibold text-slate-100">{children}</strong>,
  em: ({ children }: { children: ReactNode }) => <em className="italic">{children}</em>,
  code: ({ children }: { children: ReactNode }) => (
    <code className="bg-slate-800 text-emerald-300/80 px-1 py-0.5 rounded text-[10px] font-mono">{children}</code>
  ),
  ul: ({ children }: { children: ReactNode }) => <ul className="list-disc list-inside mb-1 space-y-0.5">{children}</ul>,
  ol: ({ children }: { children: ReactNode }) => <ol className="list-decimal list-inside mb-1 space-y-0.5">{children}</ol>,
  li: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  pre: ({ children }: { children: ReactNode }) => <pre className="bg-slate-800 rounded p-1.5 my-1 text-[10px] font-mono overflow-x-auto">{children}</pre>,
  a: ({ href, children }: { href?: string; children: ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline underline-offset-2">{children}</a>
  ),
};

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  return `${sec}s`;
}

export function StreamingCard({
  variant,
  content,
  streaming = false,
  autoScroll = true,
  maxHeight,
  header,
  footer,
  children,
  elapsedMs,
  onStop,
  onOptionClick,
  className,
}: StreamingCardProps) {
  const { containerRef, userScrolledUp } = useAutoScroll({
    enabled: autoScroll && streaming,
    deps: [content],
  });

  const showContent = typeof content === 'string' && content.length > 0;

  // ── Variant presets ──────────────────────────────────────────────────

  if (variant === 'thinking') {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        {/* Header */}
        {header ?? (
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-amber-400/80 uppercase tracking-wider font-semibold">
                  Thinking<span className="inline-flex w-4 ml-0.5"><AnimatedDots /></span>
                </span>
                {elapsedMs !== undefined && (
                  <span className="text-[10px] text-slate-500 font-mono">{formatElapsed(elapsedMs)}</span>
                )}
                <span className="animate-pulse w-1.5 h-1.5 rounded-full bg-amber-400/60 ml-1" />
              </div>
            </div>
            {onStop && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onStop(); }}
                className="flex-shrink-0 h-8 px-2.5 text-red-400 hover:text-red-300 hover:bg-red-950/30 rounded text-[11px] font-medium"
                title="Stop pipeline"
                aria-label="Stop pipeline"
              >
                Stop
              </button>
            )}
          </div>
        )}

        {/* Content */}
        {showContent ? (
          <div
            ref={containerRef}
            className="ml-2 rounded-lg border border-slate-800/60 bg-slate-900/40 overflow-y-auto overscroll-contain"
            style={maxHeight ? { maxHeight } : undefined}
          >
            {/* Sticky header inside scroll container */}
            <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm border-b border-slate-800/40">
              <div className="flex items-center gap-1.5 px-3 py-2">
                <span className="text-[10px] text-amber-400/80 uppercase tracking-wider font-semibold">
                  Thinking<span className="inline-flex w-4 ml-0.5"><AnimatedDots /></span>
                </span>
                {elapsedMs !== undefined && (
                  <span className="text-[10px] text-slate-500 font-mono">{formatElapsed(elapsedMs)}</span>
                )}
                <span className="animate-pulse w-1.5 h-1.5 rounded-full bg-amber-400/60 ml-1" />
              </div>
            </div>
            {/* Markdown content */}
            <div className="px-3 pb-3">
              <div className="text-[11px] text-slate-300 leading-relaxed thought-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {content}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        ) : (
          <div className="ml-2 flex items-center gap-2 px-2 py-1">
            <span className="text-[11px] text-slate-500 font-medium">Working</span>
            {elapsedMs !== undefined && (
              <span className="text-[10px] text-slate-600 font-mono">{formatElapsed(elapsedMs)}</span>
            )}
            <span className="animate-pulse w-1.5 h-1.5 rounded-full bg-blue-400/60" />
          </div>
        )}

        {/* Children (tool calls, activity) */}
        {children}

        {/* Footer */}
        {footer}
      </div>
    );
  }

  if (variant === 'assistant') {
    return (
      <div className={cn('flex flex-col gap-1.5', className)}>
        {header}
        {showContent && (
          <div
            className={cn(
              'p-4 rounded-2xl text-sm leading-relaxed shadow-sm',
              'bg-slate-900 border border-slate-800 text-slate-200 rounded-tl-none',
              maxHeight ? 'overflow-y-auto' : '',
            )}
            ref={autoScroll ? containerRef : undefined}
            style={maxHeight ? { maxHeight } : undefined}
          >
            <div className={cn(streaming ? 'streaming-content' : '')}>
              <MarkdownMessage text={content} onOptionClick={onOptionClick} />
            </div>
          </div>
        )}
        {children}
        {footer}
      </div>
    );
  }

  if (variant === 'user') {
    return (
      <div className={cn('flex flex-col gap-1.5', className)}>
        {header}
        <div className="p-4 rounded-2xl text-sm leading-relaxed shadow-sm bg-blue-600 text-white rounded-tr-none">
          {content}
        </div>
        {children}
        {footer}
      </div>
    );
  }

  // minimal variant — content only, no decoration
  return (
    <div className={cn(className)} ref={autoScroll ? containerRef : undefined} style={maxHeight ? { maxHeight, overflow: 'auto' } : undefined}>
      {header}
      {showContent && <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>}
      {children}
      {footer}
    </div>
  );
}
