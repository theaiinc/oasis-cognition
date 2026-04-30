/**
 * mcp_tool node — dispatches a tool call to the Oasis MCP server.
 *
 * params:
 *   server?:       which MCP endpoint to call. Default: the built-in Oasis
 *                  MCP server (OASIS_MCP_URL env or http://mcp-server:8020/mcp).
 *   tool_name:     string, e.g. "memory_query"
 *   arguments:     object passed as the tool's arguments (interpolated)
 *   parse_json?:   boolean. If true (default), the returned text content is
 *                  JSON.parse'd; if the parse fails, returns the raw text.
 *
 * Returns:
 *   { out: <tool result value> }
 *
 * Transport: hand-rolled Streamable-HTTP client (no SDK in api-gateway for
 * CJS/ESM hygiene). The MCP server emits responses as SSE-formatted events
 * on a `POST /mcp` — we read the body and extract the first `data:` line,
 * which is the JSON-RPC response.
 */

import axios from 'axios';
import { registerNode, type NodeExecutor } from '../node-registry';

const DEFAULT_URL = process.env.OASIS_MCP_URL || 'http://mcp-server:8020/mcp';

/** Parse an SSE-formatted response body and return the last `data:` payload
 *  parsed as JSON. The MCP server returns a single `event: message` frame
 *  per JSON-RPC reply. */
function parseSseResponse(body: string): any {
  const dataLines: string[] = [];
  for (const line of String(body).split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) {
    // Some clients configured for plain JSON — try parsing as-is.
    try { return JSON.parse(body); } catch { return null; }
  }
  // Concatenated data lines form a single JSON payload per MCP spec.
  const joined = dataLines.join('');
  try { return JSON.parse(joined); } catch { return null; }
}

interface McpToolContent { type: string; text?: string; [k: string]: any }
interface McpToolResult { content?: McpToolContent[]; isError?: boolean }

function extractToolValue(result: McpToolResult | null, parseJson: boolean): any {
  if (!result) return null;
  if (result.isError) {
    const msg = result.content?.find(c => c.type === 'text')?.text || 'tool error';
    throw new Error(`mcp tool error: ${msg}`);
  }
  const textPart = result.content?.find(c => c.type === 'text');
  if (textPart?.text == null) return result;
  if (!parseJson) return textPart.text;
  try { return JSON.parse(textPart.text); } catch { return textPart.text; }
}

async function callMcpTool(params: {
  url: string;
  toolName: string;
  arguments: Record<string, any>;
  abortSignal?: AbortSignal;
}): Promise<any> {
  const { url, toolName, abortSignal } = params;
  const timeoutMs = 90_000;
  const client = axios.create({
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    timeout: timeoutMs,
    // Always read the body as text; MCP server emits SSE framing.
    responseType: 'text',
    transformResponse: x => x,
    validateStatus: () => true,
    signal: abortSignal,
  });

  // 1) initialize
  const initRes = await client.post(url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'oasis-workflow-engine', version: '0.1.0' },
    },
  });
  if (initRes.status >= 400) {
    throw new Error(`mcp initialize failed: HTTP ${initRes.status}: ${String(initRes.data).slice(0, 400)}`);
  }
  const sessionId = initRes.headers['mcp-session-id'] || initRes.headers['Mcp-Session-Id'];
  if (!sessionId) throw new Error('mcp initialize did not return Mcp-Session-Id');

  const withSession = axios.create({
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': String(sessionId),
    },
    timeout: timeoutMs,
    responseType: 'text',
    transformResponse: x => x,
    validateStatus: () => true,
    signal: abortSignal,
  });

  try {
    // 2) notifications/initialized
    await withSession.post(url, { jsonrpc: '2.0', method: 'notifications/initialized' });

    // 3) tools/call
    const callRes = await withSession.post(url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: toolName, arguments: params.arguments },
    });
    if (callRes.status >= 400) {
      throw new Error(`mcp tools/call HTTP ${callRes.status}: ${String(callRes.data).slice(0, 400)}`);
    }
    const parsed = parseSseResponse(callRes.data);
    if (parsed?.error) {
      throw new Error(`mcp rpc error: ${parsed.error.message} (${parsed.error.code})`);
    }
    return parsed?.result as McpToolResult;
  } finally {
    // Best-effort session close (DELETE).
    withSession.delete(url).catch(() => { /* ignore */ });
  }
}

const mcpToolNode: NodeExecutor = async ({ node, abortSignal }) => {
  const toolName = node.params?.tool_name;
  if (!toolName || typeof toolName !== 'string') {
    throw new Error('mcp_tool node: params.tool_name is required');
  }
  const args = (node.params?.arguments || {}) as Record<string, any>;
  const url = node.params?.server || DEFAULT_URL;
  const parseJson = node.params?.parse_json ?? true;

  const result = await callMcpTool({ url, toolName, arguments: args, abortSignal });
  return { out: extractToolValue(result, parseJson) };
};

export function registerMcpToolNode() {
  registerNode('mcp_tool', mcpToolNode);
}
