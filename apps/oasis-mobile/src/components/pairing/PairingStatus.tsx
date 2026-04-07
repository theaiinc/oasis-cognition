import { Wifi, WifiOff, Clock } from 'lucide-react';

interface PairingStatusProps {
  connected: boolean;
  expiresAt: Date | null;
}

export function PairingStatus({ connected, expiresAt }: PairingStatusProps) {
  const timeLeft = expiresAt ? getTimeRemaining(expiresAt) : null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-slate-900/50 border-b border-slate-800">
      <div className="flex items-center gap-1.5">
        {connected ? (
          <>
            <Wifi className="w-3 h-3 text-emerald-400" />
            <span className="text-xs text-emerald-400">Connected</span>
          </>
        ) : (
          <>
            <WifiOff className="w-3 h-3 text-red-400" />
            <span className="text-xs text-red-400">Disconnected</span>
          </>
        )}
      </div>
      {timeLeft && (
        <div className="flex items-center gap-1 ml-auto">
          <Clock className="w-3 h-3 text-slate-500" />
          <span className="text-xs text-slate-500">{timeLeft}</span>
        </div>
      )}
    </div>
  );
}

function getTimeRemaining(expiresAt: Date): string {
  const ms = expiresAt.getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
