import { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import {
  Mic, Fingerprint, CheckCircle2, AlertTriangle, Trash2, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

interface VoiceIdModalProps {
  onClose: () => void;
  voiceAgentUrl: string;
  micEnabled: boolean;
  setMicSilent: (on: boolean) => Promise<void>;
}

export function VoiceIdModal({ onClose, voiceAgentUrl, micEnabled, setMicSilent }: VoiceIdModalProps) {
  const micEnabledByModal = useRef(false);
  const [step, setStep] = useState<'loading' | 'not_enrolled' | 'recording' | 'success' | 'enrolled' | 'error'>('loading');
  const [countdown, setCountdown] = useState(5);
  const [errorMsg, setErrorMsg] = useState('');
  const { toast } = useToast();

  useEffect(() => {
    axios.get(`${voiceAgentUrl}/voice-id/status`)
      .then(res => setStep(res.data.enrolled ? 'enrolled' : 'not_enrolled'))
      .catch(() => { setStep('error'); setErrorMsg('Cannot reach voice agent'); });
  }, [voiceAgentUrl]);

  useEffect(() => {
    if (step !== 'recording') return;
    const id = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(id);
          setStep('success');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [step]);

  const startEnrollment = async () => {
    try {
      if (!micEnabled) {
        await setMicSilent(true);
        micEnabledByModal.current = true;
      }
      await axios.post(`${voiceAgentUrl}/voice-id/enroll`);
      setCountdown(5);
      setStep('recording');
    } catch {
      setStep('error');
      setErrorMsg('Failed to start enrollment');
    }
  };

  // Disable mic when enrollment finishes or modal closes
  const disableMicIfWeEnabled = useCallback(() => {
    if (micEnabledByModal.current) {
      micEnabledByModal.current = false;
      setMicSilent(false);
    }
  }, [setMicSilent]);

  // Turn off mic when recording completes
  useEffect(() => {
    if (step === 'success' || step === 'error') disableMicIfWeEnabled();
  }, [step, disableMicIfWeEnabled]);

  // Turn off mic on unmount (modal close)
  useEffect(() => () => { disableMicIfWeEnabled(); }, [disableMicIfWeEnabled]);

  const clearProfile = async () => {
    try {
      await axios.delete(`${voiceAgentUrl}/voice-id/clear`);
      toast({ title: "Voice ID Cleared", description: "All voices will be accepted now." });
      onClose();
    } catch {
      setStep('error');
      setErrorMsg('Failed to clear profile');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-[400px] overflow-hidden"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-600/20 flex items-center justify-center">
              <Fingerprint className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">Voice ID</h2>
              <p className="text-xs text-slate-500">Speaker verification</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-lg font-bold">✕</button>
        </div>

        <div className="px-6 py-6">
          {step === 'loading' && (
            <div className="flex flex-col items-center gap-3 py-4">
              <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
              <p className="text-sm text-slate-400">Checking voice profile...</p>
            </div>
          )}

          {step === 'not_enrolled' && (
            <div className="flex flex-col items-center gap-4">
              <div className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center">
                <Mic className="w-8 h-8 text-slate-500" />
              </div>
              <div className="text-center">
                <p className="text-sm text-slate-200 font-medium mb-2">No voice profile set up yet</p>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Enroll your voice so Oasis only listens to you and ignores other people, TV, and background conversations.
                </p>
              </div>
              <div className="bg-slate-800/60 rounded-xl p-4 w-full">
                <p className="text-xs text-slate-300 font-semibold mb-2">How it works:</p>
                <ol className="text-xs text-slate-400 space-y-1.5">
                  <li className="flex gap-2"><span className="text-blue-400 font-bold">1.</span> Click "Start" below</li>
                  <li className="flex gap-2"><span className="text-blue-400 font-bold">2.</span> Speak naturally for 5 seconds</li>
                  <li className="flex gap-2"><span className="text-blue-400 font-bold">3.</span> e.g. <em className="text-slate-300">"Hello, my name is Steve and I'm testing the voice enrollment feature"</em></li>
                </ol>
              </div>
              <button
                onClick={startEnrollment}
                className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2"
              >
                <Mic className="w-4 h-4" />
                Start Enrollment
              </button>
            </div>
          )}

          {step === 'recording' && (
            <div className="flex flex-col items-center gap-4 py-2">
              <motion.div
                animate={{ scale: [1, 1.15, 1] }}
                transition={{ duration: 1.5, repeat: Infinity }}
                className="w-20 h-20 rounded-full bg-red-600/20 border-2 border-red-500 flex items-center justify-center"
              >
                <Mic className="w-10 h-10 text-red-400" />
              </motion.div>
              <div className="text-center">
                <p className="text-lg font-bold text-red-400">Recording...</p>
                <p className="text-3xl font-mono font-bold text-slate-100 mt-1">{countdown}s</p>
              </div>
              <p className="text-sm text-slate-300 text-center">
                Speak now! Say anything naturally.<br />
                <span className="text-slate-500 text-xs">e.g. "Hello, I'm setting up my voice profile for Oasis"</span>
              </p>
              <div className="w-full bg-slate-800 rounded-full h-2 mt-2">
                <motion.div
                  className="bg-red-500 h-2 rounded-full"
                  initial={{ width: '0%' }}
                  animate={{ width: '100%' }}
                  transition={{ duration: 5, ease: 'linear' }}
                />
              </div>
            </div>
          )}

          {step === 'success' && (
            <div className="flex flex-col items-center gap-4 py-2">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', damping: 10 }}
                className="w-16 h-16 rounded-full bg-emerald-600/20 flex items-center justify-center"
              >
                <CheckCircle2 className="w-10 h-10 text-emerald-400" />
              </motion.div>
              <div className="text-center">
                <p className="text-sm font-bold text-emerald-400">Voice Profile Enrolled!</p>
                <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                  Oasis will now only respond to your voice.<br />
                  Other voices in the room will be ignored.
                </p>
              </div>
              <button
                onClick={onClose}
                className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium transition-colors"
              >
                Done
              </button>
            </div>
          )}

          {step === 'enrolled' && (
            <div className="flex flex-col items-center gap-4">
              <div className="w-16 h-16 rounded-full bg-emerald-600/20 flex items-center justify-center">
                <Fingerprint className="w-8 h-8 text-emerald-400" />
              </div>
              <div className="text-center">
                <p className="text-sm font-bold text-emerald-400">Voice profile is active</p>
                <p className="text-xs text-slate-400 mt-1">Only your voice triggers transcription.</p>
              </div>
              <div className="flex gap-2 w-full">
                <button
                  onClick={clearProfile}
                  className="flex-1 py-2.5 rounded-xl bg-red-900/30 hover:bg-red-900/50 text-red-400 text-sm font-medium transition-colors flex items-center justify-center gap-2 border border-red-800/30"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Clear Profile
                </button>
                <button
                  onClick={() => { setStep('not_enrolled'); }}
                  className="flex-1 py-2.5 rounded-xl bg-blue-900/30 hover:bg-blue-900/50 text-blue-400 text-sm font-medium transition-colors flex items-center justify-center gap-2 border border-blue-800/30"
                >
                  <Mic className="w-3.5 h-3.5" />
                  Re-enroll
                </button>
              </div>
              <button
                onClick={onClose}
                className="w-full py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
              >
                Close
              </button>
            </div>
          )}

          {step === 'error' && (
            <div className="flex flex-col items-center gap-4 py-2">
              <AlertTriangle className="w-10 h-10 text-amber-400" />
              <p className="text-sm text-amber-300 text-center">{errorMsg}</p>
              <button
                onClick={onClose}
                className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium transition-colors"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
