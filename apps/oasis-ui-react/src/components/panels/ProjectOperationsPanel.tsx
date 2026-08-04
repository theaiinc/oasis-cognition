import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Activity, RefreshCw, X } from 'lucide-react';
import { OASIS_BASE_URL } from '@/lib/constants';
import { Button } from '@/components/ui/button';

interface Project {
  project_id: string;
  name?: string;
  description?: string;
}

interface ProjectEvent {
  event_id: string;
  event_type: string;
  timestamp: string;
  session_id: string;
}

interface Operations {
  active_sessions: Array<{ session_id: string; started_at: string }>;
  events: ProjectEvent[];
  jobs: Array<{ job_id: string; status: string }>;
}

export function ProjectOperationsPanel({ onClose }: { onClose: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [operations, setOperations] = useState<Record<string, Operations>>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await axios.get(`${OASIS_BASE_URL}/api/v1/projects`);
      const nextProjects = Array.isArray(response.data) ? response.data : response.data?.projects || [];
      setProjects(nextProjects);
      const entries = await Promise.all(nextProjects.map(async (project: Project) => {
        try {
          const result = await axios.get(`${OASIS_BASE_URL}/api/v1/project/operations`, {
            params: { project_id: project.project_id, limit: 10 },
          });
          return [project.project_id, result.data as Operations] as const;
        } catch {
          return [project.project_id, { active_sessions: [], events: [], jobs: [] }] as const;
        }
      }));
      setOperations(Object.fromEntries(entries));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <section className="w-full max-w-3xl h-full bg-[#0a0f1a] border-r border-slate-800 overflow-y-auto p-6">
      <header className="flex items-center justify-between mb-6">
        <div>
          <p className="text-xs uppercase tracking-widest text-cyan-400">Execution control</p>
          <h2 className="text-xl font-semibold text-white">Project Operations</h2>
          <p className="text-sm text-slate-400 mt-1">Monitor Cognition execution across projects.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="icon" onClick={() => void refresh()} title="Refresh">
            <RefreshCw className={loading ? 'animate-spin' : ''} size={17} />
          </Button>
          <Button variant="ghost" size="icon" onClick={onClose} title="Close">
            <X size={18} />
          </Button>
        </div>
      </header>
      <div className="grid gap-3">
        {projects.map((project) => {
          const state = operations[project.project_id] || { active_sessions: [], events: [], jobs: [] };
          return (
            <article key={project.project_id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-medium text-slate-100">{project.name || project.project_id}</h3>
                  <p className="text-xs text-slate-500 mt-1">{project.project_id}</p>
                </div>
                <span className="inline-flex items-center gap-1 text-xs text-emerald-300">
                  <Activity size={13} />
                  {state.active_sessions.length} active
                </span>
              </div>
              <div className="mt-3 text-xs text-slate-400">
                <span>{state.jobs.length} agent job{state.jobs.length === 1 ? '' : 's'}</span>
                {' · '}
                {state.events.length > 0
                  ? `Latest activity: ${state.events[state.events.length - 1]?.event_type}`
                  : 'No recent execution events'}
              </div>
            </article>
          );
        })}
        {!loading && projects.length === 0 && (
          <p className="text-sm text-slate-400">No projects registered yet.</p>
        )}
      </div>
    </section>
  );
}
