import { useState, useMemo } from 'react';

const COLLAPSED_LINES = 30;

interface TruncatedOutputProps {
  text: string;
  maxCollapsedLines?: number;
  className?: string;
}

/**
 * Renders large text blocks with truncation and a "Show more / Show less" toggle.
 * Prevents DOM thrashing from rendering 500+ line tool outputs inline.
 */
export function TruncatedOutput({
  text,
  maxCollapsedLines = COLLAPSED_LINES,
  className = '',
}: TruncatedOutputProps) {
  const [expanded, setExpanded] = useState(false);

  const { lines, needsTruncation } = useMemo(() => {
    const allLines = text.split('\n');
    return {
      lines: allLines,
      needsTruncation: allLines.length > maxCollapsedLines,
    };
  }, [text, maxCollapsedLines]);

  const displayText = expanded || !needsTruncation
    ? text
    : lines.slice(0, maxCollapsedLines).join('\n');

  return (
    <div className={className}>
      <pre className="text-[11px] font-mono text-slate-400 whitespace-pre-wrap break-words leading-relaxed">
        {displayText}
      </pre>
      {needsTruncation && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(v => !v);
          }}
          className="mt-1 text-[10px] font-medium text-blue-400 hover:text-blue-300 transition-colors"
        >
          {expanded
            ? 'Show less'
            : `Show ${lines.length - maxCollapsedLines} more lines...`}
        </button>
      )}
    </div>
  );
}
