import { describeAxiosError } from './gateway.js';

/**
 * Shape of an MCP tool result that returns text content.
 *
 * Returning JSON-stringified objects (rather than structured data) keeps
 * things simple and lets the receiving model reason over the full payload.
 */
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** Wrap an async handler and convert thrown errors into an MCP error result. */
export async function handle<T>(fn: () => Promise<T>): Promise<ToolResult> {
  try {
    const data = await fn();
    const text =
      typeof data === 'string'
        ? data
        : JSON.stringify(data, null, 2);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `ERROR: ${describeAxiosError(err)}` }],
      isError: true,
    };
  }
}

/** Return a plain-text ok result. */
export function text(msg: string): ToolResult {
  return { content: [{ type: 'text', text: msg }] };
}
