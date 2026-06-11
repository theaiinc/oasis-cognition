/**
 * Agent Runner (Ratatoskr runner) — registers with Yggdrasil as an agent-capable
 * runner, polls for assigned tasks, and executes them in-place as a full sub-agent
 * using its own LLM capability with tool-use (file ops, shell, web).
 *
 * Ratatoskr has LLM capability and can run agent tasks natively — it's not a thin
 * dispatcher, it's a full sub-agent that thinks, acts, and produces results.
 *
 * Architecture:
 *   Yggdrasil is the task control plane. Runners register with capabilities
 *   resolved from *presets*, send heartbeats, and the gateway creates tasks on
 *   runners via POST /runners/:runnerId/tasks. This daemon polls Yggdrasil for
 *   running tasks, executes each one as a complete agent in-place, and updates
 *   task status via PATCH.
 *
 * Port: 8025 (default, overridable via AGENT_REGISTRY_PORT)
 *
 * Env:
 *   YGGDRASIL_URL                   — http://yggdrasil:3100
 *   YGGDRASIL_API_KEY               — optional API key
 *   YGGDRASIL_HEARTBEAT_INTERVAL_MS — heartbeat interval (default 15000)
 *   YGGDRASIL_POLL_INTERVAL_MS      — task poll interval (default 5000)
 *   AGENT_REGISTRY_PORT             — HTTP listen port (default 8025)
 *   MAX_CONCURRENT_TASKS            — max tasks to run simultaneously (default 4)
 *
 *   # Capabilities (each name IS a preset — resolved transitively)
 *   CAPABILITIES                — comma-separated preset names to register with
 *                                 e.g. 'agent'    → agent,llm,shell,web_search
 *                                 e.g. 'llm,shell' → llm,shell
 *                                 e.g. 'agent,code' → agent,llm,shell,web_search,code
 *
 *   # LLM configuration (for sub-agent execution)
 *   LLM_MODEL             — model name (default: google/gemma-4-26b-a4b-qat)
 *   LLM_BASE_URL          — OpenAI-compatible base URL for LLM
 *   LLM_API_KEY           — API key for the LLM provider
 *   DEV_AGENT_URL                   — dev-agent URL for delegated execution (optional fallback)
 */

import express from 'express';
import axios from 'axios';

// ── Capability resolution (capabilities ARE presets) ─────────────────────────

import { resolveCapabilities, applyPresetDefaults } from '@theaiinc/yggdrasil-ratatoskr';
import type { CombinedPreset } from '@theaiinc/yggdrasil-ratatoskr';
import type { PendingUpdate } from '@theaiinc/yggdrasil';


// ─── Config ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.AGENT_REGISTRY_PORT || '8025', 10);
const YGGDRASIL_URL = process.env.YGGDRASIL_URL || 'http://yggdrasil:3100';
const YGG_API_KEY = process.env.YGGDRASIL_API_KEY || '';
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.YGGDRASIL_HEARTBEAT_INTERVAL_MS || '15000', 10);
const POLL_INTERVAL_MS = parseInt(process.env.YGGDRASIL_POLL_INTERVAL_MS || '5000', 10);
const MAX_CONCURRENT_TASKS = parseInt(process.env.MAX_CONCURRENT_TASKS || '4', 10);

const RAW_CAPABILITIES = (process.env.CAPABILITIES || 'agent')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '');

const { capabilities: RUNNER_CAPABILITIES, combined: COMBINED_PRESET } = resolveCapabilities(RAW_CAPABILITIES);
applyPresetDefaults(COMBINED_PRESET);

const app = express();
app.use(express.json());

// ── State ─────────────────────────────────────────────────────────────────

let runnerId: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Tasks currently being executed in-process. */
const executingTasks = new Map<string, {
  taskId: string;
  goal: string;
  startedAt: number;
  abortController: AbortController;
}>();

/** Pending update received from Yggdrasil, deferred until tasks finish. */
let pendingUpdate: PendingUpdate | null = null;
let updateDeferredCheckTimer: ReturnType<typeof setInterval> | null = null;

// ── Helper: axios client with optional API key ────────────────────────────

function yggAxios() {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (YGG_API_KEY) headers['x-api-key'] = YGG_API_KEY;
  return axios.create({ baseURL: YGGDRASIL_URL, timeout: 10_000, headers });
}

// ── Yggdrasil runner lifecycle ────────────────────────────────────────────

async function registerWithYggdrasil(): Promise<string> {
  const res = await yggAxios().post('/runners/register', {
    name: `ratatoskr-runner-${PORT}`,
    endpoint: `http://agent-registry:${PORT}`,
    version: '0.1.0',
    capabilities: RUNNER_CAPABILITIES,
    labels: {
      'runner.type': 'ratatoskr',
      'max_concurrent': String(MAX_CONCURRENT_TASKS),
      'presets': RAW_CAPABILITIES.join(','),
    },
  });
  const id: string = res.data.runnerId;
  console.log(`[ratatoskr-runner] registered with Yggdrasil as runner=${id}`);
  return id;
}

async function sendHeartbeat(): Promise<void> {
  if (!runnerId) return;
  try {
    const tasks = Array.from(executingTasks.values()).map((t) => ({
      taskId: t.taskId,
      status: 'running' as const,
      startedAt: t.startedAt,
      metadata: { goal: t.goal.slice(0, 120) },
    }));
    const res = await yggAxios().post('/runners/heartbeat', {
      runnerId,
      tasks,
    });

    // Capture pending update from Yggdrasil — deferred until tasks complete
    const update = res.data?.pendingUpdate;
    if (update && !pendingUpdate) {
      pendingUpdate = update;
      console.log(`[ratatoskr-runner] Update requested by Yggdrasil: version=${update.version} (deferred)`);
    }
  } catch (err: any) {
    console.warn(`[ratatoskr-runner] heartbeat failed: ${err.message}`);
  }
}

async function markOffline(): Promise<void> {
  if (!runnerId) return;
  try {
    await yggAxios().post('/runners/offline', { runnerId });
    console.log(`[ratatoskr-runner] marked offline`);
  } catch (err: any) {
    console.warn(`[ratatoskr-runner] offline notification failed: ${err.message}`);
  }
}

// ── Task polling — find tasks assigned to us via Yggdrasil ────────────────

async function pollForTasks(): Promise<void> {
  if (!runnerId) return;

  try {
    const { data } = await yggAxios().get(`/runners/${runnerId}/tasks`, {
      params: { status: 'running' },
    });
    const tasks: Array<{ taskId: string; type?: string; metadata?: Record<string, unknown> }> = data?.tasks ?? [];

    for (const task of tasks) {
      // Skip tasks we're already executing
      if (executingTasks.has(task.taskId)) continue;

      // Check concurrency limit
      if (executingTasks.size >= MAX_CONCURRENT_TASKS) {
        console.warn(`[ratatoskr-runner] concurrency limit reached, skipping task ${task.taskId}`);
        continue;
      }

      const goal = (task.metadata?.goal as string) || task.type || 'agent task';
      console.log(`[ratatoskr-runner] picked up task ${task.taskId}: ${goal.slice(0, 80)}`);

      executeTask(task.taskId, goal);
    }
  } catch (err: any) {
    // 404 is fine — runner might not have tasks yet
    if (err.response?.status !== 404) {
      console.warn(`[ratatoskr-runner] poll failed: ${err.message}`);
    }
  }
}

// ── LLM configuration (sub-agent brain) ───────────────────────────────────

const LLM_MODEL = process.env.LLM_MODEL || 'google/gemma-4-26b-a4b-qat';
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'http://host.docker.internal:1234/v1';
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OASIS_OPENAI_API_KEY || '';
const MAX_TOOL_ITERATIONS = parseInt(process.env.AGENT_MAX_TOOL_ITERATIONS || '25', 10);

// ── Tool implementations ───────────────────────────────────────────────────

interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

const tools: Record<string, (...args: string[]) => Promise<ToolResult>> = {
  /** Execute a shell command and return stdout+stderr. */
  shell: async (command: string): Promise<ToolResult> => {
    try {
      const { execSync } = await import('child_process');
      const result = execSync(command, { timeout: 30_000, encoding: 'utf-8', stdio: 'pipe', shell: '/bin/sh' });
      return { success: true, output: result.trim().slice(0, 100_000), error: '' };
    } catch (err: any) {
      return { success: false, output: err.stdout?.toString().trim().slice(0, 100_000) ?? '', error: err.stderr?.toString().trim() ?? err.message };
    }
  },

  /** Read a file from disk. */
  read_file: async (path: string): Promise<ToolResult> => {
    try {
      const fs = require('fs');
      const content = fs.readFileSync(path, 'utf-8');
      return { success: true, output: content.slice(0, 100_000) };
    } catch (err: any) {
      return { success: false, output: '', error: err.message };
    }
  },

  /** Write content to a file. Creates parent directories if needed. */
  write_file: async (path: string, content: string): Promise<ToolResult> => {
    try {
      const fs = require('fs');
      const pathModule = require('path');
      fs.mkdirSync(pathModule.dirname(path), { recursive: true });
      fs.writeFileSync(path, content, 'utf-8');
      return { success: true, output: `Written ${content.length} bytes to ${path}` };
    } catch (err: any) {
      return { success: false, output: '', error: err.message };
    }
  },

  /** Search the web via DuckDuckGo (proxied through tool-executor or direct). */
  web_search: async (query: string): Promise<ToolResult> => {
    try {
      const { default: axios } = await import('axios');
      const res = await axios.get('https://api.duckduckgo.com', {
        params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 },
        timeout: 15_000,
      });
      const results = res.data?.RelatedTopics ?? [];
      const output = Array.isArray(results)
        ? results.slice(0, 5).map((r: any) => r.Text || r.FirstURL || JSON.stringify(r)).join('\n')
        : JSON.stringify(results);
      return { success: true, output: output || 'No results found.' };
    } catch (err: any) {
      return { success: false, output: '', error: err.message };
    }
  },

  /** Fetch a URL and return the text content. */
  web_fetch: async (url: string): Promise<ToolResult> => {
    try {
      const { default: axios } = await import('axios');
      const res = await axios.get(url, { timeout: 30_000, responseType: 'text' });
      return { success: true, output: (typeof res.data === 'string' ? res.data : JSON.stringify(res.data)).slice(0, 100_000) };
    } catch (err: any) {
      return { success: false, output: '', error: err.message };
    }
  },

  /** Execute a Python script. */
  python: async (script: string): Promise<ToolResult> => {
    try {
      const { execSync } = await import('child_process');
      const result = execSync(`/app/python-venv/bin/python3 -c ${JSON.stringify(script)}`, {
        timeout: 60_000, encoding: 'utf-8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024,
      });
      return { success: true, output: result.trim().slice(0, 100_000), error: '' };
    } catch (err: any) {
      return { success: false, output: err.stdout?.toString().trim().slice(0, 100_000) ?? '', error: err.stderr?.toString().trim() ?? err.message };
    }
  },

  /** Execute a Node.js script. */
  node: async (script: string): Promise<ToolResult> => {
    try {
      const { execSync } = await import('child_process');
      const result = execSync(`node -e ${JSON.stringify(script)}`, {
        timeout: 60_000, encoding: 'utf-8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024,
      });
      return { success: true, output: result.trim().slice(0, 100_000), error: '' };
    } catch (err: any) {
      return { success: false, output: err.stdout?.toString().trim().slice(0, 100_000) ?? '', error: err.stderr?.toString().trim() ?? err.message };
    }
  },

  /** Run a GitHub CLI command. */
  github: async (command: string, ...args: string[]): Promise<ToolResult> => {
    try {
      const { execSync } = await import('child_process');
      const ghToken = process.env.GITHUB_TOKEN || '';
      const fullArgs = args.join(' ');
      const cmd = `gh ${command} ${fullArgs}`;
      const result = execSync(cmd, {
        timeout: 120_000, encoding: 'utf-8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...(ghToken ? { GH_TOKEN: ghToken } : {}) } as Record<string, string>,
      });
      return { success: true, output: result.trim().slice(0, 100_000), error: '' };
    } catch (err: any) {
      return { success: false, output: err.stdout?.toString().trim().slice(0, 100_000) ?? '', error: err.stderr?.toString().trim() ?? err.message };
    }
  },
};

const toolNames = Object.keys(tools);

// ── Sub-agent loop (LLM-powered think-act-execute) ─────────────────────────

/**
 * Run a goal through a full sub-agent loop:
 *
 *   1. Send the goal + tool schema to the LLM
 *   2. LLM responds with either a tool call or final answer
 *   3. If tool call → execute → observe → repeat (up to MAX_TOOL_ITERATIONS)
 *   4. If final answer → return it
 *
 * Ratatoskr is the sub-agent: it has LLM capability and can run agent tasks
 * as a first-class citizen, not just delegate to external services.
 */
async function runAgentTask(
  goal: string,
  signal?: AbortSignal,
): Promise<{ finalMessage: string; model: string; tokens: { input: number; output: number } }> {
  // Build OpenAI-compatible request
  const messages: Array<{ role: string; content: string }> = [
    {
      role: 'system',
      content: [
        'You are a capable sub-agent running inside a Ratatoskr runner. Your job is to accomplish the given goal.',
        'You have access to these tools (respond with a JSON function call):',
        '',
        ...toolNames.map((name) => {
          const tool = tools[name];
          return `  - ${name}: ${tool.name === 'shell' ? 'Execute a shell command' : tool.name === 'read_file' ? 'Read a file' : tool.name === 'write_file' ? 'Write a file' : tool.name === 'web_search' ? 'Search the web' : 'Fetch a URL'}`;
        }),
        '',
        'To use a tool, respond with a JSON block:',
        '```tool',
        '{"name": "<tool_name>", "arguments": {"arg1": "value", ...}}',
        '```',
        '',
        'After observing the result, continue working toward the goal.',
        'When you have completed the goal, respond with your final answer in a JSON block:',
        '```final',
        '{"result": "your answer here", "summary": "brief summary of what was done"}',
        '```',
        '',
        'Be thorough and precise. Read files before modifying them. Verify your work.',
        'The workspace is mounted at /workspace. Write results there.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `Goal: ${goal}`,
    },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalAnswer = '';
  let lastModel = LLM_MODEL;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    // Check for cancellation
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Call the LLM
    const llmResponse = await callLlm(messages, signal);
    totalInputTokens += llmResponse.inputTokens;
    totalOutputTokens += llmResponse.outputTokens;
    lastModel = llmResponse.model;

    const content = llmResponse.content.trim();

    // Extract tool call
    const toolMatch = content.match(/```tool\n([\s\S]*?)```/);
    const finalMatch = content.match(/```final\n([\s\S]*?)```/);

    if (finalMatch) {
      // Agent produced a final answer
      try {
        const parsed = JSON.parse(finalMatch[1]);
        finalAnswer = parsed.result || parsed.summary || content;
        break;
      } catch {
        finalAnswer = content;
        break;
      }
    }

    if (toolMatch) {
      // Parse and execute the tool call
      let call: { name: string; arguments: Record<string, string> };
      try {
        call = JSON.parse(toolMatch[1]);
      } catch {
        messages.push({ role: 'assistant', content });
        messages.push({
          role: 'user',
          content: 'Error: Invalid JSON in tool block. Please use valid JSON.',
        });
        continue;
      }

      const fn = tools[call.name];
      if (!fn) {
        messages.push({ role: 'assistant', content });
        messages.push({
          role: 'user',
          content: `Error: Unknown tool "${call.name}". Available: ${toolNames.join(', ')}`,
        });
        continue;
      }

      // Execute the tool
      const argValues = Object.values(call.arguments);
      const result = await fn(...argValues);

      const observation = result.success
        ? `Output:\n${result.output}`
        : `Error: ${result.error || result.output}`;

      console.log(`[sub-agent] iter=${iteration}, tool=${call.name}, success=${result.success}`);

      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: `Observation:\n${observation}` });
      continue;
    }

    // No structured output found — send content back as assistant message
    // and ask for structured response
    messages.push({ role: 'assistant', content });
    messages.push({
      role: 'user',
      content:
        'Please respond with either a `tool` block to use a tool, or a `final` block with your answer.',
    });
  }

  if (!finalAnswer) {
    finalAnswer = 'Max iterations reached without a final answer.';
  }

  return {
    finalMessage: finalAnswer,
    model: lastModel,
    tokens: { input: totalInputTokens, output: totalOutputTokens },
  };
}

/**
 * Call the LLM with the given messages. Returns content + token counts.
 * Uses OpenAI-compatible API.
 */
async function callLlm(
  messages: Array<{ role: string; content: string }>,
  signal?: AbortSignal,
): Promise<{ content: string; model: string; inputTokens: number; outputTokens: number }> {
  const url = LLM_BASE_URL
    ? `${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`
    : 'https://api.deepseek.com/v1/chat/completions';

  const { data } = await axios.post(
    url,
    {
      model: LLM_MODEL,
      messages,
      max_tokens: 4096,
      temperature: 0.3,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      signal,
      timeout: 120_000,
    },
  );

  return {
    content: data.choices?.[0]?.message?.content || '',
    model: data.model || LLM_MODEL,
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  };
}

async function executeTask(taskId: string, goal: string): Promise<void> {
  const abortController = new AbortController();

  executingTasks.set(taskId, {
    taskId,
    goal,
    startedAt: Date.now(),
    abortController,
  });

  try {
    console.log(`[ratatoskr-runner] executing task ${taskId}...`);

    // ── Agent execution ──────────────────────────────────────────────
    // The runner is a full sub-agent: it uses its own LLM capability to think,
    // plan, and act. Ratatoskr runs the goal through a think-act-execute loop
    // with shell, file, and web tools — just like any agent would.
    const result = await runAgentTask(goal, abortController.signal);

    // Report completion via PATCH to Yggdrasil
    await yggAxios().patch(`/runners/${runnerId}/tasks/${taskId}`, {
      status: 'completed',
      metadata: {
        final_message: result.finalMessage,
        model: result.model,
        tokens: result.tokens,
      },
    });

    console.log(`[ratatoskr-runner] task ${taskId} completed`);
  } catch (err: any) {
    if (err.name === 'AbortError') {
      // Task was cancelled
      await yggAxios().patch(`/runners/${runnerId}/tasks/${taskId}`, {
        status: 'failed',
        metadata: { error: 'Task cancelled' },
      }).catch(() => {});
      console.log(`[ratatoskr-runner] task ${taskId} cancelled`);
    } else {
      // Report failure
      await yggAxios().patch(`/runners/${runnerId}/tasks/${taskId}`, {
        status: 'failed',
        metadata: { error: err.message },
      }).catch(() => {});
      console.error(`[ratatoskr-runner] task ${taskId} failed: ${err.message}`);
    }
  } finally {
    executingTasks.delete(taskId);
    await sendHeartbeat();
  }
}

// ── Deferred update (Yggdrasil signalled update via heartbeat response) ───

/**
 * Check if there's a pending update and all tasks are done.
 * If so, execute the update command and exit.
 */
function checkDeferredUpdate(): void {
  if (!pendingUpdate) return;
  if (executingTasks.size > 0) {
    console.log(`[ratatoskr-runner] Waiting for ${executingTasks.size} task(s) to finish before applying update v${pendingUpdate.version}...`);
    return;
  }

  const update = pendingUpdate;
  pendingUpdate = null; // clear so we don't re-enter

  console.log(`[ratatoskr-runner] All tasks done. Applying update: version=${update.version}`);

  try {
    if (update.command) {
      const { execSync } = require('child_process');
      console.log(`[ratatoskr-runner] Running update command: ${update.command}`);
      const output = execSync(update.command, { encoding: 'utf-8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
      console.log(`[ratatoskr-runner] Update output:\n${output}`);
    }
  } catch (err: any) {
    console.error(`[ratatoskr-runner] Update failed: ${err.message}`);
    console.error(err.stdout || '');
    console.error(err.stderr || '');
    return; // don't exit on failure
  }

  console.log(`[ratatoskr-runner] Update applied. Exiting for restart...`);
  setTimeout(() => process.exit(0), 500);
}

// ── Health endpoint ───────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    runnerId,
    active: executingTasks.size,
    maxConcurrent: MAX_CONCURRENT_TASKS,
    capabilities: RUNNER_CAPABILITIES,
  });
});

// ── Startup / shutdown ────────────────────────────────────────────────────

async function startup(): Promise<void> {
  try {
    runnerId = await registerWithYggdrasil();

    // Start periodic heartbeats
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

    // Start polling for tasks assigned to this runner
    pollTimer = setInterval(pollForTasks, POLL_INTERVAL_MS);

    console.log(`[ratatoskr-runner] listening on port ${PORT}, maxConcurrent=${MAX_CONCURRENT_TASKS}`);
  } catch (err: any) {
    console.error(`[ratatoskr-runner] startup failed: ${err.message}`);
    console.warn('[ratatoskr-runner] continuing without Yggdrasil registration');
  }
}

function shutdown(): void {
  console.log('[ratatoskr-runner] shutting down...');
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (pollTimer) clearInterval(pollTimer);

  // Cancel all executing tasks
  for (const [taskId, task] of executingTasks) {
    task.abortController.abort();
    console.log(`[ratatoskr-runner] cancelled task ${taskId}`);
  }

  markOffline().finally(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(PORT, () => {
  startup();
});
