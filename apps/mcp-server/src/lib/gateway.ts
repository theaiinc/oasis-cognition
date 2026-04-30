/**
 * Thin HTTP client wrapper around the Oasis api-gateway.
 *
 * All tool modules funnel their HTTP calls through here so there is a single
 * place to configure base URL, timeouts, and error normalisation.
 */

import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';

/** Gateway base URL.
 *  - Inside docker-compose, api-gateway is reachable at http://api-gateway:8000
 *  - On the host, it is exposed on http://localhost:8000
 */
export const GATEWAY_URL =
  process.env.OASIS_GATEWAY_URL ||
  process.env.API_GATEWAY_URL ||
  'http://localhost:8000';

const DEFAULT_TIMEOUT_MS = parseInt(process.env.OASIS_MCP_TIMEOUT_MS || '30000', 10);

export const http: AxiosInstance = axios.create({
  baseURL: GATEWAY_URL,
  timeout: DEFAULT_TIMEOUT_MS,
  // Accept any 2xx/3xx; let callers decide what to do with 4xx/5xx.
  validateStatus: status => status >= 200 && status < 400,
});

/** Normalise an axios error into a compact, model-friendly string. */
export function describeAxiosError(err: unknown): string {
  const e = err as any;
  if (e?.response) {
    const status = e.response.status;
    const body =
      typeof e.response.data === 'string'
        ? e.response.data
        : JSON.stringify(e.response.data);
    return `HTTP ${status}: ${body?.slice(0, 800) ?? ''}`;
  }
  if (e?.code) return `${e.code}: ${e.message}`;
  return e?.message || String(err);
}

/** JSON GET → returns response body. */
export async function gwGet<T = any>(path: string, params?: Record<string, any>, config?: AxiosRequestConfig): Promise<T> {
  const res = await http.get<T>(path, { ...config, params });
  return res.data;
}

/** JSON POST → returns response body. */
export async function gwPost<T = any>(path: string, body?: any, config?: AxiosRequestConfig): Promise<T> {
  const res = await http.post<T>(path, body, config);
  return res.data;
}

/** JSON PATCH → returns response body. */
export async function gwPatch<T = any>(path: string, body?: any, config?: AxiosRequestConfig): Promise<T> {
  const res = await http.patch<T>(path, body, config);
  return res.data;
}

/** JSON DELETE → returns response body. */
export async function gwDelete<T = any>(path: string, body?: any, config?: AxiosRequestConfig): Promise<T> {
  const res = await http.delete<T>(path, { ...config, data: body });
  return res.data;
}

/**
 * Stream NDJSON from the /interaction endpoint and collect the final response.
 *
 * The interaction endpoint emits multiple JSON-per-line events describing the
 * reasoning graph, partial responses, rules snapshots, etc. For an MCP tool
 * we only want to surface the final assistant text + a minimal envelope, so
 * this helper consumes the full stream and picks out the `response` event.
 */
export async function gwInteract(
  userMessage: string,
  sessionId?: string,
  context?: Record<string, any>,
  timeoutMs: number = 90_000,
): Promise<{
  session_id: string;
  response: string;
  route?: string;
  confidence?: number;
  clarifying_questions?: string[];
  events: number;
}> {
  const res = await http.post(
    '/api/v1/interaction',
    { user_message: userMessage, session_id: sessionId, context },
    {
      responseType: 'stream',
      timeout: timeoutMs,
      // Interaction emits NDJSON; we need raw access.
      transformResponse: x => x,
    },
  );

  return new Promise((resolve, reject) => {
    let buffer = '';
    let finalResponse = '';
    let finalSessionId = sessionId || '';
    let route: string | undefined;
    let confidence: number | undefined;
    let clarifying: string[] | undefined;
    let events = 0;

    const onLine = (line: string) => {
      if (!line.trim()) return;
      events++;
      let evt: any;
      try { evt = JSON.parse(line); } catch { return; }
      // The final response comes as { type: "response", response: "...", session_id, route, confidence, clarifying_questions }
      // Some variants emit { event: "response", ... }. Be permissive.
      const kind = evt?.type || evt?.event;
      if (kind === 'response' || (typeof evt?.response === 'string' && evt?.session_id)) {
        finalResponse = evt.response || finalResponse;
        finalSessionId = evt.session_id || finalSessionId;
        route = evt.route ?? route;
        confidence = evt.confidence ?? confidence;
        clarifying = evt.clarifying_questions ?? clarifying;
      }
    };

    res.data.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        onLine(line);
      }
    });
    res.data.on('end', () => {
      if (buffer.trim()) onLine(buffer);
      resolve({
        session_id: finalSessionId,
        response: finalResponse || '(no response text)',
        route,
        confidence,
        clarifying_questions: clarifying,
        events,
      });
    });
    res.data.on('error', (err: Error) => reject(err));
  });
}
