import {
  Menu, Wifi, WifiOff, Mic, MicOff, ScreenShare, ScreenShareOff,
  Fingerprint, FolderOpen, Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ProjectConfig } from '@/lib/types';
import { TokenUsageDonut } from './TokenUsageDonut';
import type { ContextBudget } from '@/lib/types';
import { MobilePairingStatus } from '../mobile/MobilePairingStatus';

interface ChatHeaderProps {
  statusText: string;
  isConnected: boolean;
  isConnecting: boolean;
  micEnabled: boolean;
  isSharing: boolean;
  /** Native vision sharing active (capture target selected via picker) */
  cuScreenSharing: boolean;
  projectConfig: ProjectConfig;
  showSidebar: boolean;
  autonomousMode: boolean;
  contextBudget: ContextBudget | null;
  onToggleSidebar: () => void;
  onToggleMic: () => void;
  onToggleScreenShare: () => void;
  /** Open the capture target picker (Chrome-style) for Vision */
  onToggleVision: () => void;
  onConnect: () => void;
  onVoiceIdClick: () => void;
  onOpenSettings: () => void;
  activeProjectName?: string;
}

export function ChatHeader({
  statusText,
  isConnected,
  isConnecting,
  micEnabled,
  isSharing,
  cuScreenSharing,
  projectConfig,
  showSidebar,
  autonomousMode,
  contextBudget,
  onToggleSidebar,
  onToggleMic,
  onToggleScreenShare,
  onToggleVision,
  onConnect,
  onVoiceIdClick,
  onOpenSettings,
  activeProjectName,
}: ChatHeaderProps) {
  // Vision button reflects native screen sharing (ComputerUsePanel) OR voice sharing
  const visionActive = cuScreenSharing || isSharing;
  return (
    <header className="h-16 border-b border-slate-800 flex items-center justify-between px-6 bg-[#030712]/50 backdrop-blur-md z-10">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" className="md:hidden text-slate-400 hover:text-white" onClick={onToggleSidebar} title="Toggle navigation">
          <Menu className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-bold tracking-tight">Oasis <span className="text-blue-500">Cognition</span> <span className="text-[10px] text-slate-600 font-mono">v2 ({__BUILD_NUMBER__})</span></h1>
        <Badge variant="outline" className={cn(
          "ml-2 flex items-center gap-1.5 border-slate-700 font-medium py-0.5",
          isConnected ? "text-emerald-400 border-emerald-900/50 bg-emerald-950/20" : "text-amber-400 border-amber-900/50 bg-amber-950/20"
        )}>
          {isConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
          {statusText}
        </Badge>
        <MobilePairingStatus />
        {autonomousMode && (
          <Badge variant="outline" className="ml-1 flex items-center gap-1.5 border-purple-500/40 bg-purple-950/30 text-purple-400 font-medium py-0.5 animate-pulse">
            <Zap className="w-3 h-3" />
            Autonomous
          </Badge>
        )}
        {projectConfig.configured && (
          <div className="flex items-center gap-2">
            <button
              onClick={onOpenSettings}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800/50 border border-slate-700/40 hover:border-slate-600 transition-colors group"
            >
              <FolderOpen className="w-3 h-3 text-slate-500 group-hover:text-blue-400" />
              <span className="text-[11px] text-slate-400 group-hover:text-slate-300 font-medium truncate max-w-[140px]">
                {activeProjectName || projectConfig.project_name || 'Project'}
              </span>
              {projectConfig.frameworks && projectConfig.frameworks.length > 0 && (
                <span className="text-[9px] text-blue-400/60 font-mono">{projectConfig.frameworks[0]}</span>
              )}
            </button>
            {contextBudget && contextBudget.input_budget > 0 && (
              <TokenUsageDonut budget={contextBudget} size={32} />
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button
          variant={micEnabled ? "default" : "secondary"}
          size="sm"
          onClick={onToggleMic}
          disabled={!isConnected}
          className={cn(
            "gap-2 transition-all font-semibold",
            micEnabled && "bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg shadow-emerald-900/20"
          )}
        >
          {micEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
          {micEnabled ? "Listening" : "Mic"}
        </Button>

        <Button
          variant={visionActive ? "default" : "secondary"}
          size="sm"
          onClick={onToggleVision}
          className={cn(
            "gap-2 transition-all font-semibold",
            visionActive && "bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-900/20"
          )}
        >
          {visionActive ? <ScreenShareOff className="w-4 h-4" /> : <ScreenShare className="w-4 h-4" />}
          {visionActive ? "Sharing" : "Vision"}
        </Button>

        <Button
          variant="secondary"
          size="sm"
          disabled={!isConnected}
          className="gap-2 transition-all font-semibold"
          onClick={onVoiceIdClick}
        >
          <Fingerprint className="w-4 h-4" />
          Voice ID
        </Button>

        <Button
          size="sm"
          onClick={onConnect}
          disabled={isConnecting}
          variant={isConnected ? "ghost" : "default"}
          className={cn(
            !isConnected && "bg-blue-600 hover:bg-blue-700 shadow-lg shadow-blue-900/30",
            isConnected && "text-slate-400 hover:text-red-400 hover:bg-red-950/20"
          )}
        >
          {isConnecting ? "Connecting..." : isConnected ? "Disconnect" : "Connect"}
        </Button>
      </div>
    </header>
  );
}
