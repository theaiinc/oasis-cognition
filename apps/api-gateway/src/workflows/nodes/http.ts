/**
 * Generic HTTP node — make an external HTTP call from inside a workflow.
 *
 * params:
 *   method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
 *   url:    string (must include scheme)
 *   headers?: Record<string, string>
 *   body?:  any (JSON-serialisable)
 *   timeout_ms?: number
 *
 * Returns:
 *   { out: { status, headers, data } }
 */

import axios from 'axios';
import { registerNode, type NodeExecutor } from '../node-registry';

const httpNode: NodeExecutor = async ({ node }) => {
  const method = String(node.params?.method || 'GET').toUpperCase();
  const url = String(node.params?.url || '');
  if (!url) throw new Error('http node: params.url is required');
  const headers = (node.params?.headers || {}) as Record<string, string>;
  const body = node.params?.body;
  const timeout = Number(node.params?.timeout_ms || 30_000);

  const res = await axios.request({
    method,
    url,
    headers,
    data: body,
    timeout,
    validateStatus: () => true,
  });
  return {
    out: {
      status: res.status,
      headers: res.headers,
      data: res.data,
    },
  };
};

export function registerHttpNode() {
  registerNode('http', httpNode);
}
