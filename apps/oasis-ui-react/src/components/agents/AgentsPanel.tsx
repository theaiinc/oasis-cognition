/**
 * Agents panel — full-width top-level surface for managing reusable agent
 * profiles (global) and per-project roles (scoped to the active project).
 * Replaces the chat area like the Workflows panel.
 */

import { useState } from 'react';
import { motion } from 'framer-motion';
import { UserCog, X, Users, ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { AgentProfilesView } from './AgentProfilesView';
import { ProjectRolesView } from './ProjectRolesView';

type View = 'profiles' | 'roles';

interface AgentsPanelProps {
  onClose: () => void;
  activeProjectId?: string;
  activeProjectName?: string;
}

export function AgentsPanel({ onClose, activeProjectId, activeProjectName }: AgentsPanelProps) {
  const [view, setView] = useState<View>('profiles');

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 'auto', opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.25, ease: 'easeInOut' }}
      className="h-full border-r border-slate-800 bg-[#0a0f1a] flex overflow-hidden flex-1"
      style={{ minWidth: 0 }}
    >
      {/* Left rail */}
      <div className="w-[160px] border-r border-slate-800 flex flex-col">
        <div className="p-3 border-b border-slate-800 flex items-center gap-2">
          <UserCog className="w-4 h-4 text-emerald-400" />
          <span className="text-sm font-semibold text-slate-200">Agents</span>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          <NavItem
            active={view === 'profiles'}
            onClick={() => setView('profiles')}
            icon={<ScrollText className="w-3.5 h-3.5" />}
            label="Profiles"
            sub="Global pool"
          />
          <NavItem
            active={view === 'roles'}
            onClick={() => setView('roles')}
            icon={<Users className="w-3.5 h-3.5" />}
            label="Roles"
            sub={activeProjectName || 'Per project'}
          />
        </nav>
      </div>

      {/* Body */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="h-11 px-3 flex items-center justify-between border-b border-slate-800">
          <div className="text-xs text-slate-400">
            {view === 'profiles' ? 'Global agent profiles — reusable configurations for any project' :
              'Project roles — per-project responsibilities bound to agent profiles'}
          </div>
          <Button variant="ghost" size="icon" className="w-7 h-7 text-slate-400 hover:text-white" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>
        <div className="flex-1 min-w-0 min-h-0">
          {view === 'profiles'
            ? <AgentProfilesView />
            : <ProjectRolesView activeProjectId={activeProjectId} activeProjectName={activeProjectName} />}
        </div>
      </div>
    </motion.div>
  );
}

function NavItem({
  active, onClick, icon, label, sub,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  sub?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left p-2 rounded transition-colors',
        active ? 'bg-emerald-900/30 border border-emerald-800/50' : 'hover:bg-slate-800/50 border border-transparent',
      )}
    >
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-xs text-slate-200">{label}</span>
      </div>
      {sub && <div className="text-[10px] text-slate-600 truncate mt-0.5">{sub}</div>}
    </button>
  );
}
