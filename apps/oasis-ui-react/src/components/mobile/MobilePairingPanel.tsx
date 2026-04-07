import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { Smartphone, X, QrCode, Shield, ShieldOff, RefreshCw, Unplug } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '../ui/button';
import { ScrollArea } from '../ui/scroll-area';
import { useToast } from '../../hooks/use-toast';
import { MOBILE_PAIRING_URL } from '../../lib/constants';
import axios from 'axios';

interface PairingStatus {
  state: 'idle' | 'awaiting_mobile' | 'paired' | 'expired';
  pairing_id?: string;
  expires_at?: string;
  tunnel_url?: string;
  screen_share_granted?: boolean;
  last_tool_request?: {
    type: string;
    timestamp: string;
    status: string;
  } | null;
}

interface InitiateResponse {
  pairing_id: string;
  qr_url: string;
  expires_at: string;
  tunnel_url: string;
}

interface MobilePairingPanelProps {
  onClose: () => void;
}

const POLL_INTERVAL_MS = 5000;
const DURATION_OPTIONS = [1, 2, 4, 6, 8, 12, 24];

export function MobilePairingPanel({ onClose }: MobilePairingPanelProps) {
  const [status, setStatus] = useState<PairingStatus>({ state: 'idle' });
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [durationHours, setDurationHours] = useState(6);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prevStateRef = useRef<PairingStatus['state']>('idle');
  const { toast } = useToast();

  const fetchStatus = useCallback(async () => {
    try {
      const res = await axios.get(`${MOBILE_PAIRING_URL}/pair/status`, { timeout: 5000 });
      const newStatus: PairingStatus = res.data;

      // Show toast when mobile device first connects
      if (prevStateRef.current === 'awaiting_mobile' && newStatus.state === 'paired') {
        const expiryText = newStatus.expires_at ? getTimeRemaining(newStatus.expires_at) : 'unknown';
        toast({
          title: 'Mobile device connected',
          description: `Secure session active — expires in ${expiryText}`,
        });
      }
      prevStateRef.current = newStatus.state;

      setStatus(newStatus);
    } catch {
      // Relay not running — show idle
      prevStateRef.current = 'idle';
      setStatus({ state: 'idle' });
    }
  }, [toast]);

  // Poll for status updates
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const initiatePairing = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await axios.post<InitiateResponse>(
        `${MOBILE_PAIRING_URL}/pair/initiate`,
        { duration_hours: durationHours },
        { timeout: 35000 },
      );
      setQrUrl(res.data.qr_url);
      await fetchStatus();
    } catch (err: any) {
      const isNetworkError = !err.response && (err.code === 'ERR_NETWORK' || err.message === 'Network Error');
      setError(isNetworkError
        ? 'Mobile relay is not reachable. Make sure it is running.'
        : (err.response?.data?.error || err.message || 'Failed to initiate pairing'));
    } finally {
      setLoading(false);
    }
  };

  const revokePairing = async () => {
    setLoading(true);
    setError(null);
    try {
      await axios.delete(`${MOBILE_PAIRING_URL}/pair`, { timeout: 10000 });
      setQrUrl(null);
      await fetchStatus();
    } catch (err: any) {
      const isNetworkError = !err.response && (err.code === 'ERR_NETWORK' || err.message === 'Network Error');
      if (!isNetworkError) {
        setError(err.response?.data?.error || err.message || 'Failed to revoke pairing');
      }
    } finally {
      setLoading(false);
    }
  };

  const toggleScreenAccess = async () => {
    try {
      await axios.post(
        `${MOBILE_PAIRING_URL}/pair/screen-access`,
        { grant: !status.screen_share_granted },
        { timeout: 10000 },
      );
      await fetchStatus();
    } catch (err: any) {
      const isNetworkError = !err.response && (err.code === 'ERR_NETWORK' || err.message === 'Network Error');
      if (!isNetworkError) {
        setError(err.response?.data?.error || err.message);
      }
    }
  };

  const expiresIn = status.expires_at ? getTimeRemaining(status.expires_at) : null;

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 420, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.25, ease: 'easeInOut' }}
      className="h-full border-r border-slate-800 bg-[#0a0f1a] flex flex-col overflow-hidden flex-shrink-0"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
        <div className="flex items-center gap-2.5">
          <Smartphone className="w-5 h-5 text-cyan-400" />
          <h2 className="text-sm font-semibold text-slate-200">Mobile Companion</h2>
        </div>
        <div className="flex items-center gap-2">
          {status.state === 'paired' && (
            <span className="text-[10px] border border-emerald-800 text-emerald-300 px-1.5 py-0.5 rounded-full animate-pulse">
              Connected
            </span>
          )}
          <Button variant="ghost" size="icon" onClick={onClose} className="text-slate-400 hover:text-white w-7 h-7">
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1 px-5 py-4">
        <div className="flex flex-col gap-4">

          {/* Error banner */}
          {error && (
            <div className="bg-red-900/30 border border-red-800 rounded-lg p-3 text-xs text-red-300">
              {error}
            </div>
          )}

          {/* IDLE STATE */}
          {status.state === 'idle' && (
            <>
              <p className="text-xs text-slate-400">
                Pair a mobile device to use Oasis as a companion app. A secure, encrypted session
                will be established via QR code.
              </p>

              <div className="flex flex-col gap-2">
                <label className="text-xs text-slate-500">Session Duration</label>
                <select
                  value={durationHours}
                  onChange={(e) => setDurationHours(Number(e.target.value))}
                  className="bg-slate-800 border border-slate-700 rounded-md px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                >
                  {DURATION_OPTIONS.map((h) => (
                    <option key={h} value={h}>
                      {h} hour{h > 1 ? 's' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <Button
                onClick={initiatePairing}
                disabled={loading}
                className="bg-cyan-600 hover:bg-cyan-700 text-white gap-2"
              >
                {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <QrCode className="w-4 h-4" />}
                Pair Mobile Device
              </Button>
            </>
          )}

          {/* AWAITING MOBILE — QR code displayed */}
          {status.state === 'awaiting_mobile' && qrUrl && (
            <>
              <p className="text-xs text-slate-400">
                Scan this QR code with your phone to pair. Open the camera app or a QR scanner.
              </p>

              <div className="bg-white rounded-lg p-4 flex items-center justify-center">
                <QRCodeSVG value={qrUrl} size={280} />
              </div>

              {expiresIn && (
                <p className="text-xs text-slate-500 text-center">
                  Session expires in {expiresIn}
                </p>
              )}

              <Button
                variant="ghost"
                onClick={revokePairing}
                disabled={loading}
                className="text-slate-400 hover:text-red-400 gap-2"
              >
                <X className="w-4 h-4" />
                Cancel
              </Button>
            </>
          )}

          {/* PAIRED STATE */}
          {status.state === 'paired' && (
            <>
              <div className="bg-emerald-900/20 border border-emerald-800/50 rounded-lg p-4 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-sm text-emerald-300 font-medium">Mobile Connected</span>
                </div>
                {expiresIn && (
                  <p className="text-xs text-slate-400">Session expires in {expiresIn}</p>
                )}
              </div>

              {/* Screen access toggle */}
              <div className="bg-slate-800/50 rounded-lg p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {status.screen_share_granted ? (
                      <Shield className="w-4 h-4 text-amber-400" />
                    ) : (
                      <ShieldOff className="w-4 h-4 text-slate-500" />
                    )}
                    <span className="text-sm text-slate-200">Screen Access</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleScreenAccess}
                    className={status.screen_share_granted
                      ? 'text-amber-400 hover:text-amber-300'
                      : 'text-slate-400 hover:text-slate-300'
                    }
                  >
                    {status.screen_share_granted ? 'Revoke' : 'Grant'}
                  </Button>
                </div>
                <p className="text-xs text-slate-500">
                  {status.screen_share_granted
                    ? 'Mobile can request screenshots and interact with your screen.'
                    : 'Mobile cannot access your screen. Grant access to enable remote tools.'
                  }
                </p>
              </div>

              {/* Last tool request */}
              {status.last_tool_request && (
                <div className="bg-slate-800/30 rounded-lg p-3 text-xs text-slate-400">
                  Last tool request: <span className="text-slate-200">{status.last_tool_request.type}</span>
                  {' '}&mdash; {status.last_tool_request.status}
                </div>
              )}

              {/* Revoke button */}
              <Button
                variant="ghost"
                onClick={revokePairing}
                disabled={loading}
                className="text-red-400 hover:text-red-300 hover:bg-red-900/20 gap-2"
              >
                <Unplug className="w-4 h-4" />
                Disconnect Mobile
              </Button>
            </>
          )}

          {/* EXPIRED STATE */}
          {status.state === 'expired' && (
            <>
              <div className="bg-slate-800/30 rounded-lg p-4 text-center">
                <p className="text-sm text-slate-400">Session expired</p>
              </div>
              <Button
                onClick={initiatePairing}
                disabled={loading}
                className="bg-cyan-600 hover:bg-cyan-700 text-white gap-2"
              >
                <QrCode className="w-4 h-4" />
                Start New Session
              </Button>
            </>
          )}
        </div>
      </ScrollArea>
    </motion.div>
  );
}

function getTimeRemaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
