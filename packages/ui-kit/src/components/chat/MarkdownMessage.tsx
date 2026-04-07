import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ReactNode, ComponentType } from 'react';
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
 */
function isQuestionWithOptions(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes('\u{1F914}') || lower.includes('i need more info')) return true;
  const questionPatterns = [
    /\?\s*\n\s*[-*\d]/,
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

/** Allows consumers to override specific markdown element renderers. */
export type ComponentOverrides = Partial<
  Record<string, ComponentType<Record<string, unknown>>>
>;

export interface MarkdownMessageProps {
  text: string;
  /** Optional click handler for clickable option list items (question/clarification messages). */
  onOptionClick?: (option: string) => void;
  /** Override specific markdown element renderers (e.g. `{ p: MyParagraph }`). */
  componentOverrides?: ComponentOverrides;
}

export function MarkdownMessage({ text, onOptionClick, componentOverrides }: MarkdownMessageProps) {
  const enableClickableOptions = useMemo(
    () => !!onOptionClick && isQuestionWithOptions(text),
    [onOptionClick, text],
  );

  const components: Record<string, unknown> = {
    code({ className, children, ...props }: { className?: string; children?: ReactNode; [k: string]: unknown }) {
      const isInline = !className;
      if (isInline) {
        return <code className="bg-slate-800 text-emerald-300 px-1.5 py-0.5 rounded text-[13px] font-mono" {...props}>{children}</code>;
      }
      return <CodeBlock className={className}>{children}</CodeBlock>;
    },
    h1: ({ children }: { children?: ReactNode }) => <h1 className="text-lg font-bold text-slate-100 mt-3 mb-1">{children}</h1>,
    h2: ({ children }: { children?: ReactNode }) => <h2 className="text-base font-bold text-slate-100 mt-3 mb-1">{children}</h2>,
    h3: ({ children }: { children?: ReactNode }) => <h3 className="text-sm font-bold text-slate-200 mt-2 mb-1">{children}</h3>,
    p: ({ children }: { children?: ReactNode }) => <p className="mb-2 last:mb-0">{children}</p>,
    ul: ({ children }: { children?: ReactNode }) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
    ol: ({ children }: { children?: ReactNode }) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
    li: ({ children }: { children?: ReactNode }) => {
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
    a: ({ href, children }: { href?: string; children?: ReactNode }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline underline-offset-2">{children}</a>
    ),
    blockquote: ({ children }: { children?: ReactNode }) => (
      <blockquote className="border-l-2 border-blue-500 pl-3 my-2 text-slate-400 italic">{children}</blockquote>
    ),
    table: ({ children }: { children?: ReactNode }) => (
      <div className="overflow-x-auto my-2"><table className="min-w-full text-sm border border-slate-700 rounded">{children}</table></div>
    ),
    thead: ({ children }: { children?: ReactNode }) => <thead className="bg-slate-800">{children}</thead>,
    th: ({ children }: { children?: ReactNode }) => <th className="px-3 py-1.5 text-left text-xs font-semibold text-slate-300 border-b border-slate-700">{children}</th>,
    td: ({ children }: { children?: ReactNode }) => <td className="px-3 py-1.5 text-slate-300 border-b border-slate-800">{children}</td>,
    strong: ({ children }: { children?: ReactNode }) => <strong className="font-semibold text-slate-100">{children}</strong>,
    em: ({ children }: { children?: ReactNode }) => <em className="italic text-slate-300">{children}</em>,
    hr: () => <hr className="border-slate-700 my-3" />,
    ...componentOverrides,
  };

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={components as Parameters<typeof ReactMarkdown>[0]['components']}
    >
      {text}
    </ReactMarkdown>
  );
}
