import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Smartphone } from 'lucide-react';
import { MOBILE_PAIRING_URL } from '../../lib/constants';
import axios from 'axios';

const POLL_INTERVAL_MS = 10000;

interface MobilePairingStatusProps {
  className?: string;
}

export function MobilePairingStatus({ className }: MobilePairingStatusProps) {
  const [paired, setPaired] = useState(false);
  const [justPaired, setJustPaired] = useState(false);
  const wasPairedRef = useRef(false);

  useEffect(() => {
    const check = async () => {
      try {
        const res = await axios.get(`${MOBILE_PAIRING_URL}/pair/status`, { timeout: 3000 });
        const nowPaired = res.data.state === 'paired';

        // Detect transition from not-paired to paired
        if (nowPaired && !wasPairedRef.current) {
          setJustPaired(true);
          setTimeout(() => setJustPaired(false), 2000);
        }
        wasPairedRef.current = nowPaired;

        setPaired(nowPaired);
      } catch {
        wasPairedRef.current = false;
        setPaired(false);
      }
    };
    check();
    const interval = setInterval(check, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  return (
    <AnimatePresence>
      {paired && (
        <motion.div
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{
            opacity: 1,
            scale: 1,
            filter: justPaired ? ['brightness(1)', 'brightness(2)', 'brightness(1)'] : 'brightness(1)',
          }}
          exit={{ opacity: 0, scale: 0.5 }}
          transition={{ duration: 0.3 }}
          className={`flex items-center gap-1.5 ${className || ''}`}
          title="Mobile device connected"
        >
          <Smartphone className={`w-3.5 h-3.5 ${justPaired ? 'text-emerald-300' : 'text-cyan-400'} transition-colors duration-1000`} />
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
