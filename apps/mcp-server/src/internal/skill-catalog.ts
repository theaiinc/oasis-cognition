/**
 * Built-in skill catalog for `search_skills` discovery.
 *
 * Skills are reusable guidance patterns for common tasks. The model discovers
 * them on demand via search_skills instead of having all skills in its prompt.
 *
 * CU (Computer-Use) skills are stored in the memory service and queried
 * separately — this catalog covers higher-level / non-CU skills.
 */

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  /** Categories this skill belongs to */
  categories: string[];
  /** Keywords for search matching */
  keywords: string[];
}

const SKILL_CATALOG: SkillEntry[] = [
  {
    id: 'skill-delegation',
    name: 'Parallel Task Delegation',
    description: 'Break a large goal into independent sub-tasks and delegate them to parallel sub-agents. Use with delegate_tasks tool.',
    categories: ['planning', 'execution'],
    keywords: ['parallel', 'delegate', 'subtask', 'sub-agent', 'subagent', 'concurrent', 'split', 'divide'],
  },
  {
    id: 'skill-missions',
    name: 'Recurring Background Missions',
    description: 'Set up cron-based background missions for auto-heal, monitoring, periodic reporting, or data sync. Use with mission_create tool.',
    categories: ['automation', 'monitoring'],
    keywords: ['recurring', 'cron', 'background', 'schedule', 'periodic', 'monitor', 'auto-heal', 'autoheal'],
  },
  {
    id: 'skill-workflows',
    name: 'Workflow Automation',
    description: 'Create DAG-based workflows with input, output, MCP tool, HTTP, delay, branch, filter, and transform nodes. Use with workflow_create tool.',
    categories: ['automation', 'integration'],
    keywords: ['workflow', 'dag', 'pipeline', 'automate', 'integration', 'sequence', 'chain'],
  },
  {
    id: 'skill-debugging-nodejs',
    name: 'Debug Node.js Application',
    description: 'Systematic approach to debugging Node.js runtime issues: inspect logs, check stack traces, reproduce with minimal test, use debugger.',
    categories: ['debugging', 'development'],
    keywords: ['debug', 'nodejs', 'node', 'javascript', 'typescript', 'error', 'bug', 'stack trace', 'crash'],
  },
  {
    id: 'skill-debugging-python',
    name: 'Debug Python Application',
    description: 'Systematic approach to debugging Python runtime issues: inspect logs, check tracebacks, reproduce with minimal script, use pdb/ipdb.',
    categories: ['debugging', 'development'],
    keywords: ['debug', 'python', 'traceback', 'error', 'bug', 'crash', 'exception'],
  },
  {
    id: 'skill-code-review',
    name: 'Code Review',
    description: 'Review code changes for correctness, style, security, and performance. Check diff, identify issues, suggest improvements.',
    categories: ['development', 'quality'],
    keywords: ['review', 'code review', 'pr', 'pull request', 'diff', 'quality', 'suggest'],
  },
  {
    id: 'skill-refactoring',
    name: 'Code Refactoring',
    description: 'Restructure existing code without changing its external behavior. Focus on readability, maintainability, and performance.',
    categories: ['development', 'quality'],
    keywords: ['refactor', 'restructure', 'clean', 'improve', 'maintainability', 'technical debt'],
  },
  {
    id: 'skill-testing',
    name: 'Write Tests',
    description: 'Add unit, integration, or e2e tests for a codebase. Cover happy path, edge cases, and error handling.',
    categories: ['development', 'testing'],
    keywords: ['test', 'unit test', 'integration test', 'e2e', 'coverage', 'jest', 'pytest', 'assert'],
  },
  {
    id: 'skill-api-design',
    name: 'API Design & Implementation',
    description: 'Design and implement REST or GraphQL APIs. Cover endpoints, request/response schemas, validation, error handling, and documentation.',
    categories: ['development', 'api'],
    keywords: ['api', 'rest', 'graphql', 'endpoint', 'route', 'http', 'schema', 'swagger', 'openapi'],
  },
  {
    id: 'skill-database-migration',
    name: 'Database Migration',
    description: 'Plan and execute database schema migrations. Handle up/down migrations, data backfills, and rollback strategies.',
    categories: ['development', 'data'],
    keywords: ['migration', 'database', 'schema', 'sql', 'prisma', 'typeorm', 'knex', 'sequelize', 'rollback'],
  },
  {
    id: 'skill-security-review',
    name: 'Security Review',
    description: 'Audit code for common security issues: injection, XSS, CSRF, auth bypass, secrets exposure, dependency vulnerabilities.',
    categories: ['security', 'quality'],
    keywords: ['security', 'audit', 'vulnerability', 'injection', 'xss', 'csrf', 'auth', 'secret', 'cve'],
  },
  {
    id: 'skill-deployment',
    name: 'Application Deployment',
    description: 'Deploy an application to staging or production. Build, configure environment, run migrations, restart services, verify health.',
    categories: ['devops', 'deployment'],
    keywords: ['deploy', 'deployment', 'release', 'build', 'ci', 'cd', 'staging', 'production', 'rollout'],
  },
  {
    id: 'skill-performance-optimization',
    name: 'Performance Optimization',
    description: 'Profile and optimize application performance. Identify bottlenecks, optimize queries, add caching, reduce latency.',
    categories: ['development', 'performance'],
    keywords: ['performance', 'optimize', 'slow', 'bottleneck', 'latency', 'caching', 'profile', 'memory'],
  },
  {
    id: 'skill-git-workflow',
    name: 'Git Branch & PR Management',
    description: 'Manage git branches, create feature branches, rebase, resolve conflicts, create pull requests with good descriptions.',
    categories: ['development', 'version-control'],
    keywords: ['git', 'branch', 'pr', 'pull request', 'merge', 'rebase', 'conflict', 'commit', 'feature branch'],
  },
  {
    id: 'skill-documentation',
    name: 'Write Documentation',
    description: 'Write clear, structured documentation: README, API docs, architecture decisions, usage guides, and changelogs.',
    categories: ['documentation', 'quality'],
    keywords: ['document', 'doc', 'readme', 'docs', 'guide', 'tutorial', 'changelog', 'api docs'],
  },
];

/**
 * Search the skill catalog by query text (matches name, description, keywords, categories).
 */
export function searchSkillCatalog(query: string, maxResults = 10): SkillEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const scored = SKILL_CATALOG.map(s => {
    const nameMatch = s.name.toLowerCase().includes(q) ? 5 : 0;
    const kwMatch = s.keywords.some(k => k.toLowerCase().includes(q)) ? 4 : 0;
    const catMatch = s.categories.some(c => c.toLowerCase().includes(q)) ? 3 : 0;
    const descMatch = s.description.toLowerCase().includes(q) ? 2 : 0;
    return { entry: s, score: nameMatch + kwMatch + descMatch + catMatch };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.entry);
}

export default SKILL_CATALOG;
