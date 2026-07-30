import { useRef, useEffect, useCallback, useState } from 'react';

const DEFAULT_SCROLL_THRESHOLD = 60;

interface UseAutoScrollOptions {
  /** How close to the bottom counts as "near bottom" (px). Default 60. */
  threshold?: number;
  /** If true, auto-scroll is active. Default true. */
  enabled?: boolean;
  /** Dependencies that trigger auto-scroll-to-bottom when they change. */
  deps?: unknown[];
}

interface UseAutoScrollReturn {
  /** Ref to attach to the scrollable container element. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** True when the user has scrolled up past the threshold. */
  userScrolledUp: boolean;
  /** Programmatically scroll to bottom. */
  scrollToBottom: () => void;
  /** Set scroll state externally (e.g., reset on streaming start). */
  resetScrollState: () => void;
}

/**
 * Unified auto-scroll hook used by StreamingCard, chat scroll area,
 * tool-calls containers, and virtualized message lists.
 *
 * Features:
 * - Detects intentional user scroll-up (ignores content-growing scrolls)
 * - Auto-scrolls to bottom when deps change (if user hasn't scrolled up)
 * - Programmatic scroll that doesn't trigger false "user scrolled up" detection
 * - Supports ResizeObserver for content expansion detection
 */
export function useAutoScroll({
  threshold = DEFAULT_SCROLL_THRESHOLD,
  enabled = true,
  deps = [],
}: UseAutoScrollOptions = {}): UseAutoScrollReturn {
  const containerRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const isProgrammaticScroll = useRef(false);
  const lastScrollTop = useRef(0);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    isProgrammaticScroll.current = true;
    el.scrollTop = el.scrollHeight;
    lastScrollTop.current = el.scrollTop;
    requestAnimationFrame(() => {
      isProgrammaticScroll.current = false;
    });
  }, []);

  const resetScrollState = useCallback(() => {
    setUserScrolledUp(false);
  }, []);

  // Detect intentional user scroll-up
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleScroll = () => {
      if (!enabled || isProgrammaticScroll.current) return;
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distFromBottom <= threshold;

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
  }, [enabled, threshold]);

  // Auto-scroll when deps change (if user hasn't scrolled up)
  useEffect(() => {
    if (!enabled || userScrolledUp) return;
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, userScrolledUp, scrollToBottom, ...deps]);

  // ResizeObserver: auto-scroll when content height grows
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let prevHeight = el.scrollHeight;
    const ro = new ResizeObserver(() => {
      const newHeight = el.scrollHeight;
      if (newHeight > prevHeight && !userScrolledUp && enabled) {
        el.scrollTop = el.scrollHeight;
        lastScrollTop.current = el.scrollTop;
      }
      prevHeight = newHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled, userScrolledUp]);

  // Reset scroll state when enabled flips from false to true (streaming starts)
  useEffect(() => {
    if (enabled) {
      requestAnimationFrame(() => scrollToBottom());
      setUserScrolledUp(false);
    }
  }, [enabled, scrollToBottom]);

  return { containerRef, userScrolledUp, scrollToBottom, resetScrollState };
}
