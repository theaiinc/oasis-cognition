import { useState, useEffect, useCallback, useRef } from 'react';
import type { PairingParams, PairingState } from '../lib/types';
import { parsePairingParams, completePairing, createIdlePairingState, restorePairingState, clearPairingState } from '../lib/pairing';

/** How many consecutive health-check failures before we declare the session dead. */
const MAX_FAILURES = 3;
/** Health check interval (ms). */
const CHECK_INTERVAL = 30_000;
/** Health check request timeout (ms). */
const CHECK_TIMEOUT = 10_000;

export function usePairing() {
  const [pairing, setPairing] = useState<PairingState>(createIdlePairingState);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [sessionEnded, setSessionEnded] = useState(false);
  const initialized = useRef(false);
  const failureCount = useRef(0);

  // On mount: try to pair from URL hash, or restore persisted session
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    (async () => {
      // First, check URL hash for fresh pairing
      const hash = window.location.hash;
      if (hash.startsWith('#pair/')) {
        const params = parsePairingParams(hash);
        if (params) {
          window.history.replaceState(null, '', window.location.pathname);
          setLoading(true);
          try {
            const state = await completePairing(params);
            setPairing(state);
          } catch (err: any) {
            setError(err.message);
          } finally {
            setLoading(false);
            setInitializing(false);
          }
          return;
        }
      }

      // No hash — try to restore previous session from sessionStorage
      const restored = await restorePairingState();
      if (restored) {
        // Verify the session is still valid — retry a few times since
        // network may be cold on page load
        const isValid = await verifySessionWithRetry(restored.tunnelUrl!, 2);
        if (isValid) {
          setPairing(restored);
        } else {
          clearPairingState();
          setSessionEnded(true);
        }
      } else {
        setSessionEnded(true);
      }
      setInitializing(false);
    })();
  }, []);

  const handlePair = useCallback(async (params: PairingParams) => {
    setLoading(true);
    setError(null);
    setSessionEnded(false);
    failureCount.current = 0;
    try {
      const state = await completePairing(params);
      setPairing(state);
    } catch (err: any) {
      setError(err.message);
      setPairing(createIdlePairingState());
    } finally {
      setLoading(false);
    }
  }, []);

  // Periodically verify session is still active with the relay.
  // Tolerates transient failures (e.g. app backgrounded, tunnel hiccup).
  useEffect(() => {
    if (!pairing.paired || !pairing.tunnelUrl || !pairing.expiresAt) return;

    let intervalId: ReturnType<typeof setInterval>;

    const checkSession = async () => {
      // Skip checks when the page is hidden (backgrounded)
      if (document.hidden) return;

      // Check local expiry
      if (new Date() > pairing.expiresAt!) {
        clearPairingState();
        setPairing(createIdlePairingState());
        setSessionEnded(true);
        return;
      }

      const isValid = await verifySession(pairing.tunnelUrl!);
      if (isValid) {
        // Reset failure counter on success
        failureCount.current = 0;
      } else {
        failureCount.current += 1;
        console.warn(`[Pairing] Health check failed (${failureCount.current}/${MAX_FAILURES})`);
        if (failureCount.current >= MAX_FAILURES) {
          clearPairingState();
          setPairing(createIdlePairingState());
          setSessionEnded(true);
        }
      }
    };

    // When page becomes visible again after being backgrounded,
    // do an immediate check (but don't kill the session on one failure)
    const onVisibilityChange = () => {
      if (!document.hidden) {
        // Small delay to let the network stack wake up
        setTimeout(checkSession, 2000);
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    intervalId = setInterval(checkSession, CHECK_INTERVAL);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [pairing.paired, pairing.expiresAt, pairing.tunnelUrl]);

  const disconnect = useCallback(() => {
    clearPairingState();
    setPairing(createIdlePairingState());
    setSessionEnded(true);
    setError(null);
  }, []);

  const pairFromScan = useCallback((qrData: string) => {
    try {
      const url = new URL(qrData);
      const params = parsePairingParams(url.hash);
      if (!params) {
        setError('Invalid QR code');
        return;
      }
      params.tunnelUrl = url.origin;
      handlePair(params);
    } catch {
      setError('Invalid QR code format');
    }
  }, [handlePair]);

  return {
    pairing,
    error,
    loading,
    initializing,
    sessionEnded,
    pairFromScan,
    disconnect,
    clearError: () => setError(null),
  };
}

/**
 * Ping the relay's health endpoint to verify the session/tunnel is still alive.
 */
async function verifySession(tunnelUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${tunnelUrl}/health`, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.pairing === 'paired';
  } catch {
    return false;
  }
}

/**
 * Verify session with retries — useful on cold start / page restore
 * where the first request might fail due to network wake-up.
 */
async function verifySessionWithRetry(tunnelUrl: string, retries: number): Promise<boolean> {
  for (let i = 0; i <= retries; i++) {
    const ok = await verifySession(tunnelUrl);
    if (ok) return true;
    if (i < retries) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return false;
}
