import { useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react';
import { cn } from '@/lib/utils';

const SCROLL_THRESHOLD = 60;

interface ToolCallsScrollContainerProps {
  children: React.ReactNode;
  isStreaming?: boolean;
  eventCount?: number;
  /** Bumps when thought layer streams chunks — scroll to bottom so the card stays visible. */
  thoughtChunkRevision?: number;
  maxHeight?: string;
  className?: string;
}

export function ToolCallsScrollContainer({
  children,
  isStreaming = false,
  eventCount = 0,
  thoughtChunkRevision,
  maxHeight = '280px',
  className,
}: ToolCallsScrollContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  // Suppress false "user scrolled up" detection during programmatic scrolls
  const isProgrammaticScroll = useRef(false);
  const lastScrollTop = useRef(0);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    isProgrammaticScroll.current = true;
    el.scrollTop = el.scrollHeight;
    lastScrollTop.current = el.scrollTop;
    // Reset flag after the browser has processed the scroll
    requestAnimationFrame(() => {
      isProgrammaticScroll.current = false;
    });
  }, []);

  // Detect intentional user scroll-up (not content growing or programmatic scroll)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleScroll = () => {
      if (!isStreaming || isProgrammaticScroll.current) return;
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distFromBottom <= SCROLL_THRESHOLD;
      // Only flag as "scrolled up" if user actively dragged up
      if (el.scrollTop < lastScrollTop.current - 5 && !atBottom) {
        setUserScrolledUp(true);
      }
      if (atBottom) {
        setUserScrolledUp(false);
      }
      lastScrollTop.current = el.scrollTop;
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [isStreaming]);

  // Auto-scroll on new events
  useEffect(() => {
    if (!isStreaming || userScrolledUp) return;
    scrollToBottom();
  }, [eventCount, isStreaming, userScrolledUp, scrollToBottom]);

  // Thought layer: pin scroll on chunk updates
  useLayoutEffect(() => {
    if (!isStreaming || thoughtChunkRevision === undefined || thoughtChunkRevision <= 0) return;
    if (userScrolledUp) return;
    scrollToBottom();
  }, [isStreaming, thoughtChunkRevision, userScrolledUp, scrollToBottom]);

  // Reset when streaming starts/stops
  useEffect(() => {
    if (!isStreaming) {
      setUserScrolledUp(false);
    } else {
      requestAnimationFrame(() => scrollToBottom());
    }
  }, [isStreaming, scrollToBottom]);

  return (
    <div
      ref={containerRef}
      className={cn(
        'overflow-y-auto overflow-x-hidden overscroll-contain',
        className
      )}
      style={{ maxHeight }}
    >
      {children}
    </div>
  );
}
