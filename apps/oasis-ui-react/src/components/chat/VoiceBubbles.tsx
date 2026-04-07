import { motion, AnimatePresence } from 'framer-motion';
import { Mic, Loader2 } from 'lucide-react';
import { VOICE_SILENCE_CUTOFF_SECONDS } from '@/lib/constants';

interface VoiceBubblesProps {
  isTranscribing: boolean;
  liveTranscript: string;
  silenceSeconds: number;
}

export function VoiceBubbles({ isTranscribing, liveTranscript, silenceSeconds }: VoiceBubblesProps) {
  return (
    <>
      <AnimatePresence>
        {isTranscribing && !liveTranscript && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="flex gap-4 max-w-[85%] ml-auto flex-row-reverse">
            <div className="w-8 h-8 rounded-full bg-blue-600/50 flex-shrink-0 flex items-center justify-center mt-1">
              <Mic className="w-4 h-4 text-white" />
            </div>
            <div className="bg-blue-600/20 border border-blue-500/20 p-4 rounded-2xl rounded-tr-none">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}>
                    <Loader2 className="w-3.5 h-3.5 text-blue-400" />
                  </motion.div>
                  {silenceSeconds < VOICE_SILENCE_CUTOFF_SECONDS ? (
                    <span className="text-xs text-blue-300/80 font-medium">
                      Short pause detected — I'll send this in {Math.max(1, Math.ceil(VOICE_SILENCE_CUTOFF_SECONDS - silenceSeconds))}s if you don't continue.
                    </span>
                  ) : (
                    <span className="text-xs text-blue-300/80 font-medium">Transcribing your speech...</span>
                  )}
                </div>
                {silenceSeconds < VOICE_SILENCE_CUTOFF_SECONDS && (
                  <div className="mt-2 w-full bg-blue-900/40 rounded-full h-1.5 overflow-hidden">
                    <motion.div className="h-1.5 rounded-full bg-blue-400" initial={{ width: '0%' }} animate={{ width: `${Math.min(100, (silenceSeconds / VOICE_SILENCE_CUTOFF_SECONDS) * 100)}%` }} transition={{ duration: 0.25, ease: 'linear' }} />
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {liveTranscript && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="flex gap-4 max-w-[85%] ml-auto flex-row-reverse">
            <div className="w-8 h-8 rounded-full bg-blue-600/50 flex-shrink-0 flex items-center justify-center mt-1">
              <Mic className="w-4 h-4 text-white animate-pulse" />
            </div>
            <div className="bg-blue-600/30 border border-blue-500/20 p-4 rounded-2xl rounded-tr-none text-blue-200 text-sm">
              {liveTranscript}
              <motion.span animate={{ opacity: [0, 1, 0] }} transition={{ duration: 0.8, repeat: Infinity }} className="inline-block ml-0.5 w-0.5 h-4 bg-blue-300 align-text-bottom" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
