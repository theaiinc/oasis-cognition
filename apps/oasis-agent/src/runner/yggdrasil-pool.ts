/**
 * Yggdrasil Agent Pool — combined orchestration controller + built-in
 * Ratatoskr runner in a single process.
 *
 * This replaces both the standalone orchestration-controller.js (from the npm
 * package) and the separate agent-registry. It runs on one port and Yggdrasil
 * itself acts as the agent pool — no external runner registration needed.
 *
 * Architecture:
 *   ┌─────────────────────────────────┐
 *   │         yggdrasil-pool          │
 *   │  ┌───────────────────────────┐  │
 *   │  │  Orchestration controller │  │  ← POST /runners/register, /heartbeat
 *   │  │  (runners Map, tasks,     │  │  ← PATCH /runners/:id/tasks/:tid
 *   │  │   health, metrics,        │  │  ← GET  /api/runners, /health
 *   │  │   lease detection)        │  │
 *   │  └──────────┬────────────────┘  │
 *   │             │ self-register     │
 *   │  ┌──────────▼────────────────┐  │
 *   │  │  Built-in Ratatoskr       │  │  ← polls its own runners Map
 *   │  │  runner (capabilities     │  │  ← executes tasks in-process
 *   │  │  resolved from presets)   │  │  ← sub-agent think-act-execute loop
 *   │  └───────────────────────────┘  │
 *   └─────────────────────────────────┘
 *
 * Port: 3100 (default, overridable via PORT)
 *
 * Env:
 *   PORT                    — HTTP listen port (default 3100)
 *   API_KEYS                — comma-separated API keys (optional)
 *   LEASE_TTL_MS            — heartbeat timeout before marking offline (default 60000)
 *
 *   # Capabilities (each name IS a preset — resolved transitively)
 *   CAPABILITIES            — comma-separated preset names (default: 'agent')
 *                             Known presets resolve their dependsOn deps and
 *                             load handlers. Unknown names pass through as raw
 *                             capabilities.
 *                             e.g. 'agent'    → agent + llm + shell + web_search
 *                             e.g. 'llm,shell' → llm, shell
 *                             e.g. 'agent,code' → agent + llm + shell + web_search + code
 *
 *   MAX_CONCURRENT_TASKS    — max sub-agent tasks to run simultaneously (default 4)
 *   LLM_MODEL     — model name (default: google/gemma-4-26b-a4b-qat)
 *   LLM_BASE_URL  — OpenAI-compatible base URL (default: http://host.docker.internal:1234/v1)
 *   LLM_API_KEY   — API key (falls back to OASIS_OPENAI_API_KEY)
 *   AGENT_MAX_TOOL_ITERATIONS — max tool call cycles (default 25)
 */

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import axios from 'axios';
import { nanoid } from 'nanoid';

// ── Capability resolution (capabilities ARE presets) ─────────────────────────

import {
  resolveCapabilities,
  applyPresetDefaults,
} from '@theaiinc/yggdrasil-ratatoskr';
import type { CombinedPreset } from '@theaiinc/yggdrasil-ratatoskr';

// ── Wire protocol types from @theaiinc/yggdrasil ────────────────────────────

import type {
  RunnerInfo,
  RunnerTask,
  SystemResources,
  PendingUpdate,
  HeartbeatResponse,
} from '@theaiinc/yggdrasil';

// ─── Config ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] || '3100', 10);
const API_KEYS = (process.env['API_KEYS'] || '')
  .split(',')
  .map(k => k.trim())
  .filter(k => k !== '');
const LEASE_TTL_MS = parseInt(process.env['LEASE_TTL_MS'] || '60000', 10);
const EXPECTED_RUNNER_VERSION = process.env.EXPECTED_RUNNER_VERSION || '';

const MAX_CONCURRENT_TASKS = parseInt(
  process.env.MAX_CONCURRENT_TASKS || '4',
  10,
);

// ── Capabilities (each name IS a preset) ─────────────────────────────────────

const RAW_CAPABILITIES = (process.env.CAPABILITIES || 'agent')
  .split(',')
  .map(s => s.trim())
  .filter(s => s !== '');

const { capabilities: BUILTIN_CAPABILITIES, combined: BUILTIN_PRESET } =
  resolveCapabilities(RAW_CAPABILITIES);

// Apply every preset-env default to process.env (only if not already set).
// This MUST happen before the LLM config constants read env vars below.
applyPresetDefaults(BUILTIN_PRESET);

// ─── State ──────────────────────────────────────────────────────────────────

const runners = new Map<string, RunnerInfo>();

// ─── Express setup ─────────────────────────────────────────────────────────

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json());

// ─── API key auth ───────────────────────────────────────────────────────────

app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/metrics') return next();
  if (API_KEYS.length === 0) return next();
  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (!apiKey || !API_KEYS.includes(apiKey)) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
    return;
  }
  next();
});

// ─── Health / Metrics ───────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  const online = Array.from(runners.values()).filter(
    r => r.status === 'online',
  );
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
    uptime: process.uptime(),
    runners: {
      total: runners.size,
      online: online.length,
      offline: runners.size - online.length,
    },
  });
});

app.get('/metrics', (_req, res) => {
  const online = Array.from(runners.values()).filter(
    r => r.status === 'online',
  );
  const runningTasks = Array.from(runners.values()).reduce(
    (sum, r) => sum + r.tasks.filter(t => t.status === 'running').length,
    0,
  );
  const lines: string[] = [
    '# HELP yggdrasil_runners_total Total number of registered runners',
    '# TYPE yggdrasil_runners_total gauge',
    `yggdrasil_runners_total ${runners.size}`,
    '# HELP yggdrasil_runners_online Number of online runners',
    '# TYPE yggdrasil_runners_online gauge',
    `yggdrasil_runners_online ${online.length}`,
    '# HELP yggdrasil_tasks_running Number of running tasks',
    '# TYPE yggdrasil_tasks_running gauge',
    `yggdrasil_tasks_running ${runningTasks}`,
  ];
  for (const [id, runner] of runners) {
    if (runner.resources && runner.status === 'online') {
      const labels = `runner="${id}",name="${runner.name}"`;
      lines.push(`# HELP yggdrasil_runner_cpu_percent CPU usage percent`);
      lines.push(`# TYPE yggdrasil_runner_cpu_percent gauge`);
      lines.push(
        `yggdrasil_runner_cpu_percent{${labels}} ${runner.resources.cpu.percent}`,
      );
      lines.push(`# HELP yggdrasil_runner_memory_percent Memory usage percent`);
      lines.push(`# TYPE yggdrasil_runner_memory_percent gauge`);
      lines.push(
        `yggdrasil_runner_memory_percent{${labels}} ${runner.resources.memory.percent}`,
      );
    }
  }

  // Expected runner version info
  if (EXPECTED_RUNNER_VERSION) {
    lines.push(
      '# HELP yggdrasil_expected_runner_version Expected runner version (always 1) — label carries expected version',
    );
    lines.push('# TYPE yggdrasil_expected_runner_version info');
    lines.push(
      `yggdrasil_expected_runner_version{version="${EXPECTED_RUNNER_VERSION}"} 1`,
    );
  }

  // Per-runner version info
  for (const [id, runner] of runners) {
    const verLabels = `runner="${id}",name="${runner.name}",version="${runner.version}"`;
    lines.push(
      `# HELP yggdrasil_runner_version_info Runner version (always 1) — labels carry version`,
    );
    lines.push(`# TYPE yggdrasil_runner_version_info gauge`);
    lines.push(`yggdrasil_runner_version_info{${verLabels}} 1`);

    // Outdated flag: 1 if EXPECTED_RUNNER_VERSION is set and runner version differs
    if (EXPECTED_RUNNER_VERSION && runner.version !== EXPECTED_RUNNER_VERSION) {
      const outdatedLabels = `runner="${id}",name="${runner.name}",current="${runner.version}",expected="${EXPECTED_RUNNER_VERSION}"`;
      lines.push(
        `# HELP yggdrasil_runner_outdated Outdated runner flag (1 = version mismatch)`,
      );
      lines.push(`# TYPE yggdrasil_runner_outdated gauge`);
      lines.push(`yggdrasil_runner_outdated{${outdatedLabels}} 1`);
    }

    if (runner.pendingUpdate) {
      const updLabels = `runner="${id}",name="${runner.name}",current_version="${runner.version}",target_version="${runner.pendingUpdate.version}"`;
      lines.push(
        `# HELP yggdrasil_runner_pending_update Pending update flag (1 = update pending)`,
      );
      lines.push(`# TYPE yggdrasil_runner_pending_update gauge`);
      lines.push(`yggdrasil_runner_pending_update{${updLabels}} 1`);
    }
  }
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(lines.join('\n') + '\n');
});

// ─── Runner lifecycle ───────────────────────────────────────────────────────

app.post('/runners/register', (req, res) => {
  const body = req.body;
  const runnerId = body.runnerId || nanoid();
  runners.set(runnerId, {
    runnerId,
    name: body.name || 'unknown',
    endpoint: body.endpoint || 'unknown',
    version: body.version || '0.1.0',
    capabilities: body.capabilities || [],
    labels: body.labels || {},
    realmTemplates: body.realmTemplates || [],
    lastHeartbeat: new Date(),
    status: 'online',
    resources: body.resources,
    tasks: body.tasks || [],
  });
  console.log(
    `[yggdrasil] runner registered: ${runnerId} (${body.name || 'unknown'})`,
  );
  res.status(201).json({ runnerId, status: 'registered' });
});

app.post('/runners/heartbeat', (req, res) => {
  const body = req.body;
  const runner = runners.get(body.runnerId);
  if (!runner) {
    res.status(404).json({ error: 'Runner not found' });
    return;
  }
  runner.lastHeartbeat = new Date();
  runner.status = 'online';
  if (body.resources) runner.resources = body.resources;
  if (body.tasks) runner.tasks = body.tasks;

  // Deliver pending update on heartbeat response, then clear it
  const pendingUpdate = runner.pendingUpdate;
  if (pendingUpdate) {
    delete runner.pendingUpdate;
  }

  res.json({ status: 'ok', ...(pendingUpdate ? { pendingUpdate } : {}) });
});

/**
 * Request an update for a specific runner.
 * The update is stored and delivered on the next heartbeat response.
 * The runner defers execution until all running tasks complete.
 */
app.post('/runners/:runnerId/request-update', (req, res) => {
  const runner = runners.get(req.params.runnerId);
  if (!runner) {
    res.status(404).json({ error: 'Runner not found' });
    return;
  }

  const { version, command, downloadUrl, metadata } = req.body;
  if (!version) {
    res.status(400).json({ error: 'version is required' });
    return;
  }

  runner.pendingUpdate = {
    version,
    ...(command !== undefined ? { command } : {}),
    ...(downloadUrl !== undefined ? { downloadUrl } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };

  console.log(
    `[yggdrasil] update requested for runner ${req.params.runnerId}: version=${version}`,
  );
  res.json({
    status: 'update_requested',
    runnerId: req.params.runnerId,
    pendingUpdate: runner.pendingUpdate,
  });
});

app.post('/runners/update', (req, res) => {
  const body = req.body;
  const runner = runners.get(body.runnerId);
  if (!runner) {
    res.status(404).json({ error: 'Runner not found' });
    return;
  }
  runner.endpoint = body.newEndpoint || runner.endpoint;
  runner.lastHeartbeat = new Date();
  res.json({ status: 'updated' });
});

app.post('/runners/offline', (req, res) => {
  const body = req.body;
  const runner = runners.get(body.runnerId);
  if (!runner) {
    res.status(404).json({ error: 'Runner not found' });
    return;
  }
  runner.status = 'offline';
  console.log(`[yggdrasil] runner offline: ${body.runnerId}`);
  res.json({ status: 'offline' });
});

// ─── Task management ────────────────────────────────────────────────────────

app.post('/runners/:runnerId/tasks', (req, res) => {
  const runner = runners.get(req.params.runnerId);
  if (!runner) {
    res.status(404).json({ error: 'Runner not found' });
    return;
  }
  const body = req.body;
  const task: RunnerTask = {
    taskId: body.taskId || `task-${nanoid(8)}`,
    type: body.type,
    status: body.status || 'running',
    startedAt: Date.now(),
    ...(body.correlationId ? { correlationId: body.correlationId } : {}),
    ...(body.metadata ? { metadata: body.metadata } : {}),
  };
  runner.tasks.push(task);
  console.log(
    `[yggdrasil] task created: ${task.taskId} on runner ${req.params.runnerId} (type=${task.type || '?'})`,
  );
  res.status(201).json(task);
});

app.patch('/runners/:runnerId/tasks/:taskId', (req, res) => {
  const runner = runners.get(req.params.runnerId);
  if (!runner) {
    res.status(404).json({ error: 'Runner not found' });
    return;
  }
  const task = runner.tasks.find(t => t.taskId === req.params.taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const body = req.body;
  if (body.status) {
    task.status = body.status;
    if (body.status === 'completed' || body.status === 'failed') {
      task.completedAt = Date.now();
    }
  }
  if (body.metadata) {
    task.metadata = { ...task.metadata, ...body.metadata };
  }
  res.json(task);
});

app.get('/runners/:runnerId/tasks', (req, res) => {
  const runner = runners.get(req.params.runnerId);
  if (!runner) {
    res.status(404).json({ error: 'Runner not found' });
    return;
  }
  const { status } = req.query;
  let tasks = runner.tasks;
  if (status) tasks = tasks.filter(t => t.status === status);
  res.json({ runnerId: runner.runnerId, tasks, count: tasks.length });
});

// ─── Runner queries ─────────────────────────────────────────────────────────

app.get('/api/runners', (_req, res) => {
  res.json({
    runners: Array.from(runners.values()).map(r => ({
      runnerId: r.runnerId,
      name: r.name,
      endpoint: r.endpoint,
      version: r.version,
      capabilities: r.capabilities,
      labels: r.labels,
      status: r.status,
      lastHeartbeat: r.lastHeartbeat,
      resources: r.resources,
      tasks: r.tasks,
    })),
    count: runners.size,
  });
});

app.get('/api/runners/:runnerId', (req, res) => {
  const runner = runners.get(req.params.runnerId);
  if (!runner) {
    res.status(404).json({ error: 'Runner not found' });
    return;
  }
  res.json(runner);
});

// ─── Lease-based offline detection ──────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [runnerId, runner] of runners) {
    if (runner.status === 'offline') continue;
    const elapsed = now - runner.lastHeartbeat.getTime();
    if (elapsed > LEASE_TTL_MS) {
      runner.status = 'offline';
      console.warn(
        `[yggdrasil] runner ${runnerId} marked offline (no heartbeat for ${Math.round(elapsed / 1000)}s)`,
      );
    }
  }
}, 10_000);

// ═══════════════════════════════════════════════════════════════════════════
// ── Built-in Ratatoskr runner (Yggdrasil IS the agent pool) ──────────────
// ═══════════════════════════════════════════════════════════════════════════

const BUILTIN_RUNNER_ID = nanoid();

/** Tasks currently being executed in-process by the built-in runner. */
const executingTasks = new Map<
  string,
  {
    taskId: string;
    goal: string;
    startedAt: number;
    abortController: AbortController;
  }
>();

const llmModel = process.env.LLM_MODEL || 'google/gemma-4-26b-a4b-qat';
const llmBaseUrl =
  process.env.LLM_BASE_URL || 'http://host.docker.internal:1234/v1';
const llmApiKey =
  process.env.LLM_API_KEY || process.env.OASIS_OPENAI_API_KEY || '';
const maxToolIterations = parseInt(
  process.env.AGENT_MAX_TOOL_ITERATIONS ||
    process.env.LLM_MAX_TOOL_ITERATIONS ||
    '25',
  10,
);

function registerBuiltinRunner(): void {
  const runner: RunnerInfo = {
    runnerId: BUILTIN_RUNNER_ID,
    name: 'yggdrasil-builtin',
    endpoint: `http://yggdrasil:${PORT}`,
    version: '0.1.0',
    capabilities: BUILTIN_CAPABILITIES,
    labels: {
      'runner.type': 'builtin',
      max_concurrent: String(MAX_CONCURRENT_TASKS),
      presets: RAW_CAPABILITIES.join(','),
      handlers: Object.keys(BUILTIN_PRESET.handlers).join(','),
    },
    realmTemplates: [],
    lastHeartbeat: new Date(),
    status: 'online',
    tasks: [],
  };
  runners.set(BUILTIN_RUNNER_ID, runner);
  console.log(`[yggdrasil] built-in runner registered: ${BUILTIN_RUNNER_ID}`);
  console.log(
    `[yggdrasil] activated presets: ${RAW_CAPABILITIES.join(', ')} → capabilities: ${BUILTIN_CAPABILITIES.join(', ')}`,
  );
}

// ── Tools for the sub-agent ─────────────────────────────────────────────────

interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

async function executeTool(name: string, args: string[]): Promise<ToolResult> {
  try {
    switch (name) {
      case 'shell': {
        const { execSync } = await import('child_process');
        const result = execSync(args[0], {
          timeout: 30_000,
          encoding: 'utf-8',
          stdio: 'pipe',
          shell: '/bin/sh',
        });
        return {
          success: true,
          output: result.trim().slice(0, 100_000),
          error: '',
        };
      }
      case 'read_file': {
        const fs = require('fs');
        const content = fs.readFileSync(args[0], 'utf-8');
        return { success: true, output: content.slice(0, 100_000) };
      }
      case 'write_file': {
        const fs = require('fs');
        const pathModule = require('path');
        fs.mkdirSync(pathModule.dirname(args[0]), { recursive: true });
        fs.writeFileSync(args[0], args[1], 'utf-8');
        return {
          success: true,
          output: `Written ${args[1].length} bytes to ${args[0]}`,
        };
      }
      case 'web_search': {
        const { default: axios } = await import('axios');
        const res = await axios.get('https://api.duckduckgo.com', {
          params: { q: args[0], format: 'json', no_html: 1, skip_disambig: 1 },
          timeout: 15_000,
        });
        const results = res.data?.RelatedTopics ?? [];
        const output = Array.isArray(results)
          ? results
              .slice(0, 5)
              .map((r: any) => r.Text || r.FirstURL || JSON.stringify(r))
              .join('\n')
          : JSON.stringify(results);
        return { success: true, output: output || 'No results.', error: '' };
      }
      case 'web_fetch': {
        const { default: axios } = await import('axios');
        const res = await axios.get(args[0], {
          timeout: 30_000,
          responseType: 'text',
        });
        return {
          success: true,
          output: (typeof res.data === 'string'
            ? res.data
            : JSON.stringify(res.data)
          ).slice(0, 100_000),
          error: '',
        };
      }
      case 'python': {
        const { execSync } = await import('child_process');
        const pyResult = execSync(
          `/app/python-venv/bin/python3 -c ${JSON.stringify(args[0])}`,
          {
            timeout: 60_000,
            encoding: 'utf-8',
            stdio: 'pipe',
            maxBuffer: 10 * 1024 * 1024,
          },
        );
        return {
          success: true,
          output: pyResult.trim().slice(0, 100_000),
          error: '',
        };
      }
      case 'node': {
        const { execSync } = await import('child_process');
        const nodeResult = execSync(`node -e ${JSON.stringify(args[0])}`, {
          timeout: 60_000,
          encoding: 'utf-8',
          stdio: 'pipe',
          maxBuffer: 10 * 1024 * 1024,
        });
        return {
          success: true,
          output: nodeResult.trim().slice(0, 100_000),
          error: '',
        };
      }
      case 'github': {
        const { execSync } = await import('child_process');
        const ghToken = process.env.GITHUB_TOKEN || '';
        const ghResult = execSync(`gh ${args[0]} ${args.slice(1).join(' ')}`, {
          timeout: 120_000,
          encoding: 'utf-8',
          stdio: 'pipe',
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...process.env,
            ...(ghToken ? { GH_TOKEN: ghToken } : {}),
          } as Record<string, string>,
        });
        return {
          success: true,
          output: ghResult.trim().slice(0, 100_000),
          error: '',
        };
      }
      default:
        return { success: false, output: '', error: `Unknown tool: ${name}` };
    }
  } catch (err: any) {
    return { success: false, output: '', error: err.message };
  }
}

// ── Sub-agent execution loop ────────────────────────────────────────────────

async function executeTask(taskId: string, goal: string): Promise<void> {
  const abortController = new AbortController();
  executingTasks.set(taskId, {
    taskId,
    goal,
    startedAt: Date.now(),
    abortController,
  });

  try {
    console.log(
      `[yggdrasil] executing built-in task ${taskId}: ${goal.slice(0, 80)}`,
    );

    const result = await runSubAgent(goal, abortController.signal);

    // Update task status directly in the runners Map
    const runner = runners.get(BUILTIN_RUNNER_ID);
    if (runner) {
      const task = runner.tasks.find(t => t.taskId === taskId);
      if (task) {
        task.status = 'completed';
        task.completedAt = Date.now();
        task.metadata = { ...task.metadata, ...result.metadata };
      }
    }
    console.log(`[yggdrasil] built-in task ${taskId} completed`);
  } catch (err: any) {
    console.error(`[yggdrasil] built-in task ${taskId} failed: ${err.message}`);
    const runner = runners.get(BUILTIN_RUNNER_ID);
    if (runner) {
      const task = runner.tasks.find(t => t.taskId === taskId);
      if (task) {
        task.status = 'failed';
        task.completedAt = Date.now();
        task.metadata = { ...task.metadata, error: err.message };
      }
    }
  } finally {
    executingTasks.delete(taskId);
  }
}

async function runSubAgent(
  goal: string,
  signal?: AbortSignal,
): Promise<{
  status: string;
  metadata?: Record<string, unknown>;
  error?: string;
}> {
  if (!llmApiKey) {
    return {
      status: 'completed',
      metadata: {
        final_message: `No LLM configured (set LLM_API_KEY or OASIS_OPENAI_API_KEY). Goal: "${goal.slice(0, 120)}"`,
        tokens: { input: 0, output: 0 },
      },
    };
  }

  const messages: Array<{ role: string; content: string }> = [
    {
      role: 'system',
      content: [
        'You are a capable sub-agent running inside the Yggdrasil agent pool.',
        'Your job is to accomplish the given goal.',
        '',
        'Available tools:',
        '  - shell <command>          Execute a shell command',
        '  - read_file <path>        Read a file from disk',
        '  - write_file <path> <content>  Write content to a file',
        '  - web_search <query>      Search the web',
        '  - web_fetch <url>         Fetch a URL',
        '',
        'To use a tool, respond with:',
        '```tool',
        '{"name": "<tool_name>", "arguments": {"arg1": "value", ...}}',
        '```',
        '',
        'After observing the result, continue working toward the goal.',
        'When done, respond with:',
        '```final',
        '{"result": "your answer", "summary": "brief summary"}',
        '```',
        '',
        'Be thorough. Read before modifying. Verify your work.',
      ].join('\n'),
    },
    { role: 'user', content: `Goal: ${goal}` },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalAnswer = '';
  let lastModel = llmModel;

  for (let iter = 0; iter < maxToolIterations; iter++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const llmResponse = await callLlm(messages);
    totalInputTokens += llmResponse.inputTokens;
    totalOutputTokens += llmResponse.outputTokens;
    lastModel = llmResponse.model;

    const content = llmResponse.content.trim();
    const toolMatch = content.match(/```tool\n([\s\S]*?)```/);
    const finalMatch = content.match(/```final\n([\s\S]*?)```/);

    if (finalMatch) {
      try {
        const parsed = JSON.parse(finalMatch[1]);
        finalAnswer = parsed.result || parsed.summary || content;
      } catch {
        finalAnswer = content;
      }
      break;
    }

    if (toolMatch) {
      let call: { name: string; arguments: Record<string, string> };
      try {
        call = JSON.parse(toolMatch[1]);
      } catch {
        messages.push({ role: 'assistant', content });
        messages.push({
          role: 'user',
          content: 'Invalid JSON in tool block. Use valid JSON.',
        });
        continue;
      }

      const result = await executeTool(
        call.name,
        Object.values(call.arguments),
      );
      const observation = result.success
        ? `Output:\n${result.output}`
        : `Error: ${result.error || result.output}`;

      console.log(
        `[yggdrasil] tool ${call.name} iter=${iter} success=${result.success}`,
      );

      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: `Observation:\n${observation}` });
      continue;
    }

    messages.push({ role: 'assistant', content });
    messages.push({
      role: 'user',
      content: 'Respond with a `tool` block or a `final` block.',
    });
  }

  if (!finalAnswer)
    finalAnswer = 'Max iterations reached without a final answer.';

  return {
    status: 'completed',
    metadata: {
      final_message: finalAnswer,
      model: lastModel,
      tokens: { input: totalInputTokens, output: totalOutputTokens },
    },
  };
}

async function callLlm(
  messages: Array<{ role: string; content: string }>,
): Promise<{
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}> {
  const url = llmBaseUrl
    ? `${llmBaseUrl.replace(/\/$/, '')}/chat/completions`
    : 'https://api.deepseek.com/v1/chat/completions';

  const { data } = await axios.post(
    url,
    { model: llmModel, messages, max_tokens: 4096, temperature: 0.3 },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llmApiKey}`,
      },
      timeout: 120_000,
    },
  );

  return {
    content: data.choices?.[0]?.message?.content || '',
    model: data.model || llmModel,
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  };
}

// ── Poll loop for built-in runner ───────────────────────────────────────────

function pollBuiltinTasks(): void {
  const runner = runners.get(BUILTIN_RUNNER_ID);
  if (!runner) return;

  const running = runner.tasks.filter(t => t.status === 'running');

  for (const task of running) {
    if (executingTasks.has(task.taskId)) continue; // already executing
    if (executingTasks.size >= MAX_CONCURRENT_TASKS) break;

    const goal = (task.metadata?.goal as string) || task.type || 'agent task';
    console.log(
      `[yggdrasil] built-in runner picked up task ${task.taskId}: ${goal.slice(0, 80)}`,
    );
    executeTask(task.taskId, goal);
  }
}

// ─── Send heartbeats for the built-in runner ────────────────────────────────

function heartbeatBuiltinRunner(): void {
  const runner = runners.get(BUILTIN_RUNNER_ID);
  if (!runner) return;
  runner.lastHeartbeat = new Date();
  runner.status = 'online';
  runner.tasks = runner.tasks.map(t => {
    const executing = executingTasks.get(t.taskId);
    if (executing) {
      return {
        ...t,
        startedAt: executing.startedAt,
        metadata: { ...t.metadata, goal: executing.goal.slice(0, 120) },
      };
    }
    return t;
  });
}

// ─── Startup ────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[yggdrasil] agent pool listening on port ${PORT}`);

  // Self-register as the built-in Ratatoskr runner
  registerBuiltinRunner();

  // Poll for tasks assigned to the built-in runner every 5s
  setInterval(pollBuiltinTasks, 5_000);

  // Send heartbeats for the built-in runner every 15s
  setInterval(heartbeatBuiltinRunner, 15_000);

  console.log(
    `[yggdrasil] built-in runner active (maxConcurrent=${MAX_CONCURRENT_TASKS}, llmConfigured=${!!llmApiKey})`,
  );
});

// ─── Graceful shutdown ──────────────────────────────────────────────────────

function shutdown(): void {
  console.log('[yggdrasil] shutting down...');

  // Cancel executing built-in tasks
  for (const [taskId, task] of executingTasks) {
    task.abortController.abort();
  }

  // Mark built-in runner offline
  const runner = runners.get(BUILTIN_RUNNER_ID);
  if (runner) runner.status = 'offline';

  console.log('[yggdrasil] shutdown complete');
}

process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
