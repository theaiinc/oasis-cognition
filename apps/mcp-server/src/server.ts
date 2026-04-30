/**
 * Build an MCP server with every Oasis tool group registered.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerComputerUseTools } from './tools/computer-use.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerArtifactTools } from './tools/artifacts.js';
import { registerInteractionTools } from './tools/interaction.js';
import { registerCodeGraphTools } from './tools/code-graph.js';
import { registerProjectTools } from './tools/project.js';
import { registerHistoryTools } from './tools/history.js';
import { registerAgentsTools } from './tools/agents.js';
import { registerWorkflowTools } from './tools/workflows.js';
import { registerWebTools } from './tools/web.js';
import { registerAgentProfileTools } from './tools/agent-profiles.js';
import { registerProjectRoleTools } from './tools/project-roles.js';

export function createOasisMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'oasis-cognition',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        'Tools to drive Oasis Cognition: control the computer-use agent (cu_*), ' +
        'search artifacts and memory, ask Oasis itself via oasis_ask, inspect ' +
        'code graphs, manage projects and chat history, and spawn third-party ' +
        'coding agents (Claude Code) via agent_* tools.',
    },
  );

  registerComputerUseTools(server);
  registerMemoryTools(server);
  registerArtifactTools(server);
  registerInteractionTools(server);
  registerCodeGraphTools(server);
  registerProjectTools(server);
  registerHistoryTools(server);
  registerAgentsTools(server);
  registerWorkflowTools(server);
  registerWebTools(server);
  registerAgentProfileTools(server);
  registerProjectRoleTools(server);

  return server;
}
