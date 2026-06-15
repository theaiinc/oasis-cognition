import axios from 'axios';
import type { z } from 'zod';
import { ZodError } from 'zod';

const FAST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;

export interface FetchContractOptions {
  timeout?: number;
  retries?: number;
  signal?: AbortSignal;
}

/**
 * Typed HTTP fetch with Zod response validation and retries.
 *
 * - Validates the response body against the provided Zod schema
 * - Catches contract drift immediately with a clear error message
 * - Supports timeout, retries, and abort signals (same semantics as axiosWithRetry)
 */
export async function fetchContract<T>(
  method: 'get' | 'post' | 'patch' | 'delete',
  url: string,
  schema: z.ZodType<T>,
  dataOrConfig?: any,
  config?: any,
  options: FetchContractOptions = {},
): Promise<T> {
  const timeout = options.timeout ?? FAST_TIMEOUT_MS;
  const maxRetries = options.retries ?? MAX_RETRIES;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (options.signal?.aborted) throw new DOMException('Pipeline cancelled', 'AbortError');

      let res;
      if (method === 'get') {
        res = await axios.get(url, { ...dataOrConfig, timeout, signal: options.signal });
      } else if (method === 'delete') {
        res = await axios.delete(url, { ...dataOrConfig, timeout, signal: options.signal });
      } else if (method === 'patch') {
        res = await axios.patch(url, dataOrConfig, { ...config, timeout, signal: options.signal });
      } else {
        res = await axios.post(url, dataOrConfig, { ...config, timeout, signal: options.signal });
      }

      // Validate response against the Zod schema
      try {
        return schema.parse(res.data);
      } catch (validationErr) {
        if (validationErr instanceof ZodError) {
          const baseMsg = `Contract validation failed for ${method.toUpperCase()} ${url}`;
          const issues = validationErr.issues
            .slice(0, 10)
            .map(i => `  - ${i.path.join('.')}: ${i.message} (received: ${JSON.stringify(i.received)})`)
            .join('\n');
          throw new Error(`${baseMsg}\n${issues}`);
        }
        throw validationErr;
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || err.name === 'CanceledError') throw err;
      // If it's already a contract validation error, don't retry
      if (err.message?.startsWith('Contract validation failed')) throw err;

      const isRetryable =
        err.code === 'ECONNREFUSED' ||
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'ENOTFOUND' ||
        err.message?.includes('socket hang up') ||
        (err.response?.status && err.response.status >= 502 && err.response.status <= 504);

      if (!isRetryable || attempt >= maxRetries) throw err;

      // Exponential backoff before retry
      const delay = Math.min(200 * Math.pow(2, attempt), 2000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error(`fetchContract: unreachable (${method} ${url})`);
}
