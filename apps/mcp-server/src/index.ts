#!/usr/bin/env node
/**
 * Oasis MCP server — entry point.
 *
 * Transports (selected via MCP_TRANSPORT env or --stdio / --http CLI flag):
 *   - stdio (default when run with --stdio or when stdin is piped) — for
 *     Claude Desktop and anything that spawns the server as a subprocess.
 *   - http (default otherwise) — Streamable HTTP (+ legacy SSE on /sse) for
 *     remote voice agents. Listens on MCP_PORT (default 8020).
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { createOasisMcpServer } from './server.js';
import { GATEWAY_URL } from './lib/gateway.js';

const MCP_PORT = parseInt(process.env.MCP_PORT || '8020', 10);
const MCP_TRANSPORT = (process.env.MCP_TRANSPORT || '').toLowerCase();

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function runStdio() {
  const server = createOasisMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is fine for Claude Desktop; stdout is reserved for the JSON-RPC stream.
  console.error(`[oasis-mcp] stdio transport ready (gateway=${GATEWAY_URL})`);
}

async function runHttp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // CORS — voice agents often run in browsers. Permissive by default; tighten
  // via OASIS_MCP_CORS_ORIGIN if you need to.
  const corsOrigin = process.env.OASIS_MCP_CORS_ORIGIN || '*';
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Mcp-Session-Id, Last-Event-ID, Authorization',
    );
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'oasis-mcp-server', gateway: GATEWAY_URL });
  });

  /* ── Streamable HTTP (modern) ──────────────────────────────────────────
   * One endpoint handles POST (JSON-RPC requests/notifications), GET (server
   * -> client SSE stream keyed by Mcp-Session-Id), and DELETE (session end).
   */
  const streamTransports = new Map<string, StreamableHTTPServerTransport>();

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport = sessionId ? streamTransports.get(sessionId) : undefined;

    if (!transport) {
      // Only initialize requests are allowed to open a new session.
      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32000,
            message: 'Bad Request: missing Mcp-Session-Id or not an initialize request',
          },
        });
        return;
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          streamTransports.set(sid, transport!);
          console.error(`[oasis-mcp] streamable-http session init: ${sid}`);
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) {
          streamTransports.delete(transport!.sessionId);
          console.error(`[oasis-mcp] streamable-http session closed: ${transport!.sessionId}`);
        }
      };

      const server = createOasisMcpServer();
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? streamTransports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send('Missing or unknown Mcp-Session-Id');
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? streamTransports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send('Missing or unknown Mcp-Session-Id');
      return;
    }
    await transport.handleRequest(req, res);
  });

  /* ── Legacy SSE transport ──────────────────────────────────────────────
   * Kept for clients that don't yet speak Streamable HTTP (e.g. some Realtime
   * voice agents). GET /sse opens the stream; POST /messages?sessionId=... sends.
   */
  const sseTransports = new Map<string, SSEServerTransport>();

  app.get('/sse', async (_req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    sseTransports.set(transport.sessionId, transport);
    res.on('close', () => sseTransports.delete(transport.sessionId));
    const server = createOasisMcpServer();
    await server.connect(transport);
    console.error(`[oasis-mcp] sse session: ${transport.sessionId}`);
  });

  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string | undefined;
    const transport = sessionId ? sseTransports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send('Missing or unknown sessionId');
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  app.listen(MCP_PORT, () => {
    console.error(`[oasis-mcp] http transport listening on :${MCP_PORT}`);
    console.error(`[oasis-mcp]   streamable:  http://localhost:${MCP_PORT}/mcp`);
    console.error(`[oasis-mcp]   sse legacy:  http://localhost:${MCP_PORT}/sse`);
    console.error(`[oasis-mcp]   gateway:     ${GATEWAY_URL}`);
  });
}

async function main() {
  const wantStdio = MCP_TRANSPORT === 'stdio' || hasFlag('--stdio');
  const wantHttp = MCP_TRANSPORT === 'http' || hasFlag('--http');
  if (wantStdio && !wantHttp) {
    await runStdio();
  } else {
    await runHttp();
  }
}

main().catch(err => {
  console.error('[oasis-mcp] fatal:', err);
  process.exit(1);
});
