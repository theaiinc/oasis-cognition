import { useRef, useEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChatMessage } from './ChatMessage';
import { timelineClientKeyForMessage } from '@/lib/utils';
import type { Message, TimelineEvent } from '@/lib/types';

interface VirtualizedChatMessagesProps {
  messages: Message[];
  timelineByClientMessageId: Record<string, TimelineEvent[]>;
  onOptionClick: (option: string) => void;
  onReply: (id: string, text: string) => void;
  onViewTimeline: (id: string) => void;
  onEditResend: (text: string) => void;
  onResend: (text: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Called when the user scrolls near the top to load earlier history. */
  loadMore?: () => void;
  /** Whether more pages are available. */
  hasMore?: boolean;
  /** Whether a page load is in-flight. */
  loadingMore?: boolean;
}

export function VirtualizedChatMessages({
  messages,
  timelineByClientMessageId,
  onOptionClick,
  onReply,
  onViewTimeline,
  onEditResend,
  onResend,
  inputRef,
  loadMore,
  hasMore = false,
  loadingMore = false,
}: VirtualizedChatMessagesProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(messages.length);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loaderRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 5,
  });

  // Track last message content length to detect streaming updates
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const lastMsgContentLen = lastMsg?.text?.length ?? 0;
  const userScrolledUp = useRef(false);
  const lastScrollTop = useRef(0);

  // Detect intentional user scroll-up
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const handleScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (el.scrollTop < lastScrollTop.current - 10 && distFromBottom > 150) {
        userScrolledUp.current = true;
      }
      if (distFromBottom < 150) {
        userScrolledUp.current = false;
      }
      lastScrollTop.current = el.scrollTop;
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  // Auto-scroll on new messages OR when last message content grows (streaming)
  useEffect(() => {
    if (userScrolledUp.current) return;
    if (messages.length >= prevCountRef.current) {
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(messages.length - 1, { align: 'end', behavior: 'auto' });
      });
    }
    prevCountRef.current = messages.length;
  }, [messages.length, lastMsgContentLen, virtualizer]);

  // IntersectionObserver for infinite scroll
  // Watch both sentinel and loader elements — whichever hits the viewport first
  useEffect(() => {
    if (!loadMore || !hasMore || loadingMore) return;

    const targets: Element[] = [];
    if (sentinelRef.current) targets.push(sentinelRef.current);
    if (loaderRef.current) targets.push(loaderRef.current);

    if (targets.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some(e => e.isIntersecting) && hasMore && !loadingMore) {
          loadMore();
        }
      },
      { rootMargin: '300px 0px 0px 0px' },
    );

    targets.forEach(t => observer.observe(t));
    return () => observer.disconnect();
  }, [loadMore, hasMore, loadingMore]);

  const items = virtualizer.getVirtualItems();

  return (
    <div ref={parentRef} style={{ height: '100%', overflow: 'auto' }}>
      {/* Loading indicator (outside spacer so it's not absolutely-positioned) */}
      {loadingMore && (
        <div
          ref={loaderRef}
          className="flex items-center justify-center py-3 text-[11px] text-slate-500"
        >
          <span className="animate-pulse">Loading older messages...</span>
        </div>
      )}

      {/* Sentinel element for IntersectionObserver (triggers load when visible) */}
      {hasMore && !loadingMore && (
        <div ref={sentinelRef} className="h-px" aria-hidden="true" />
      )}

      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {items.map(virtualRow => {
          const m = messages[virtualRow.index];
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <div className="pb-6">
                <ChatMessage
                  message={m}
                  timelineEvents={timelineByClientMessageId[timelineClientKeyForMessage(m)] || []}
                  onOptionClick={onOptionClick}
                  onReply={onReply}
                  onViewTimeline={onViewTimeline}
                  onEditResend={onEditResend}
                  onResend={onResend}
                  inputRef={inputRef}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
