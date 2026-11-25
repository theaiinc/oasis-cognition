import { useCallback, useEffect, useState } from 'react';
import type { PairingState } from '../lib/types';
import { browserPushEnv, disablePush, enablePush, fetchPushConfig, isPushPreferred, isPushSupported, sendTestPush } from '../lib/push';

export interface PushState {
  supported: boolean;
  /** The desktop has VAPID keys set. */
  available: boolean;
  enabled: boolean;
  busy: boolean;
  error: string | null;
}

/** The opt-in toggle for mission notifications. */
export function usePushNotifications(pairing: PairingState) {
  const supported = isPushSupported();
  const [state, setState] = useState<PushState>(() => ({
    supported,
    available: false,
    enabled: supported && isPushPreferred({ storage: localStorage }) && Notification.permission === 'granted',
    busy: false,
    error: null,
  }));

  useEffect(() => {
    if (!supported || !pairing.paired) return;
    let live = true;
    fetchPushConfig(pairing, { fetch }).then(async (config) => {
      if (!live) return;
      setState(s => ({ ...s, available: config.enabled }));
      // Opted in on an earlier pairing: register again with this one (the relay forgets a phone when its pairing ends).
      if (config.enabled && isPushPreferred({ storage: localStorage }) && Notification.permission === 'granted') {
        try {
          await enablePush(pairing, browserPushEnv());
          if (live) setState(s => ({ ...s, enabled: true }));
        } catch { /* toggle shows off-state errors when used */ }
      }
    });
    return () => { live = false; };
  }, [supported, pairing.paired, pairing.pairingId, pairing.tunnelUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = useCallback(async () => {
    if (!supported) return;
    const turnOn = !state.enabled;
    setState(s => ({ ...s, busy: true, error: null }));
    try {
      if (turnOn) await enablePush(pairing);
      else await disablePush(pairing);
      setState(s => ({ ...s, enabled: turnOn, busy: false }));
    } catch (err: any) {
      setState(s => ({ ...s, enabled: false, busy: false, error: err?.message || 'Something went wrong' }));
    }
  }, [supported, state.enabled, pairing]);

  const test = useCallback(async () => {
    setState(s => ({ ...s, error: null }));
    try {
      await sendTestPush(pairing);
    } catch (err: any) {
      setState(s => ({ ...s, error: err?.message || 'Test failed' }));
    }
  }, [pairing]);

  return { ...state, toggle, test };
}
