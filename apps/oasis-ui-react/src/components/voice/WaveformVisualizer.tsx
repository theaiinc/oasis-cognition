import { motion } from 'framer-motion';
import { Mic } from 'lucide-react';

interface WaveformVisualizerProps {
  audioLevel: number;
  isActive: boolean;
  tick: number;
}

export function WaveformVisualizer({ audioLevel, isActive, tick }: WaveformVisualizerProps) {
  const bars = 24;
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.3 }}
      className="flex items-center justify-center gap-[3px] py-6"
    >
      {Array.from({ length: bars }).map((_, i) => {
        const centerDistance = Math.abs(i - bars / 2) / (bars / 2);
        const baseHeight = (1 - centerDistance * 0.6) * 0.5;
        const noise = Math.sin(tick / 3 + i * 0.7) * 0.3 + 0.5;
        const level = isActive ? Math.max(0.08, baseHeight * noise * Math.min(1, audioLevel * 8)) : 0.08;
        return (
          <motion.div
            key={i}
            className="w-[3px] rounded-full bg-emerald-400"
            animate={{
              height: `${Math.max(4, level * 48)}px`,
              opacity: isActive ? 0.5 + level * 0.5 : 0.2,
            }}
            transition={{ duration: 0.08, ease: 'easeOut' }}
            style={{
              boxShadow: isActive ? `0 0 ${6 + level * 10}px rgba(52, 211, 153, ${0.3 + level * 0.4})` : 'none',
            }}
          />
        );
      })}
    </motion.div>
  );
}

export function ListeningOrb() {
  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <div className="relative">
        <motion.div
          className="absolute inset-0 rounded-full bg-emerald-500/20"
          animate={{ scale: [1, 1.8, 1], opacity: [0.4, 0, 0.4] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute inset-0 rounded-full bg-emerald-500/15"
          animate={{ scale: [1, 1.5, 1], opacity: [0.3, 0, 0.3] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut', delay: 0.3 }}
        />
        <div className="relative w-14 h-14 rounded-full bg-emerald-600 flex items-center justify-center shadow-lg shadow-emerald-900/40">
          <Mic className="w-6 h-6 text-white" />
        </div>
      </div>
      <span className="text-xs text-emerald-400 font-medium tracking-wide uppercase">Listening...</span>
    </div>
  );
}
