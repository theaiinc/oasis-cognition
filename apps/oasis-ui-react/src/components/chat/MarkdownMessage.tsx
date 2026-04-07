import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { CodeBlock } from './CodeBlock';

function extractTextContent(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractTextContent).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    return extractTextContent((children as React.ReactElement<{ children?: ReactNode }>).props.children);
  }
  return '';
}

/**
 * Detect whether the message is a question/clarification that presents options.
 * Only in that case should list items be clickable.
 *
 * Patterns:
 *   - Starts with "🤔" or "**I need more info**"
 *   - Contains "?" followed by a list
 *   - Contains "which", "what would you", "do you want", "would you like", "choose", "select"
 *     followed by list items
 */
function isQuestionWithOptions(text: string): boolean {
  const lower = text.toLowerCase();
  // Direct clarification markers
  if (lower.includes('🤔') || lower.includes('i need more info')) return true;
  // Question patterns followed by list indicators (- or 1.)
  const questionPatterns = [
    /\?\s*\n\s*[-*\d]/,              // "...?\n- option" or "...?\n1. option"
    /which\s+(one|option|approach)/i,
    /what would you (like|prefer)/i,
    /would you (like|prefer|want)/i,
    /do you want/i,
    /choose (one|from|between)/i,
    /select (one|from|an option)/i,
    /here are (some|the|your) options/i,
    /pick (one|from)/i,
  ];
  return questionPatterns.some(p => p.test(text));
}

interface MarkdownMessageProps {
  text: string;
  onOptionClick?: (option: string) => void;
}

export function MarkdownMessage({ text, onOptionClick }: MarkdownMessageProps) {
  // Only enable clickable list items when the message is actually a question with options
  const enableClickableOptions = useMemo(
    () => !!onOptionClick && isQuestionWithOptions(text),
    [onOptionClick, text],
  );

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const isInline = !className;
          if (isInline) {
            return <code className="bg-slate-800 text-emerald-300 px-1.5 py-0.5 rounded text-[13px] font-mono" {...props}>{children}</code>;
          }
          return <CodeBlock className={className}>{children}</CodeBlock>;
        },
        h1: ({ children }) => <h1 className="text-lg font-bold text-slate-100 mt-3 mb-1">{children}</h1>,
        h2: ({ children }) => <h2 className="text-base font-bold text-slate-100 mt-3 mb-1">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-bold text-slate-200 mt-2 mb-1">{children}</h3>,
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
        li: ({ children }) => {
          const childText = extractTextContent(children);
          if (enableClickableOptions && onOptionClick && childText) {
            return (
              <li className="group/opt">
                <button
                  type="button"
                  onClick={() => onOptionClick(childText)}
                  className="text-left hover:text-blue-300 hover:underline underline-offset-2 transition-colors cursor-pointer"
                >
                  {children}
                </button>
              </li>
            );
          }
          return <li>{children}</li>;
        },
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline underline-offset-2">{children}</a>
        ),
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-blue-500 pl-3 my-2 text-slate-400 italic">{children}</blockquote>
        ),
        table: ({ children }) => (
          <div className="overflow-x-auto my-2"><table className="min-w-full text-sm border border-slate-700 rounded">{children}</table></div>
        ),
        thead: ({ children }) => <thead className="bg-slate-800">{children}</thead>,
        th: ({ children }) => <th className="px-3 py-1.5 text-left text-xs font-semibold text-slate-300 border-b border-slate-700">{children}</th>,
        td: ({ children }) => <td className="px-3 py-1.5 text-slate-300 border-b border-slate-800">{children}</td>,
        strong: ({ children }) => <strong className="font-semibold text-slate-100">{children}</strong>,
        em: ({ children }) => <em className="italic text-slate-300">{children}</em>,
        hr: () => <hr className="border-slate-700 my-3" />,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
