import { useState, useCallback, useRef, useEffect } from 'react';
import type { Message, PairingState } from '../lib/types';

/**
 * Voice chat state exposed to the UI.
 */
export interface VoiceChatState {
  /** Whether the WebSocket is connected and authenticated */
  isConnected: boolean;
  /** Connection in progress */
  isConnecting: boolean;
  /** Microphone is active and streaming audio */
  micEnabled: boolean;
  /** Current audio energy level (0-1) for visual feedback */
  audioLevel: number;
  /** Server detected speech in progress */
  isSpeaking: boolean;
  /** Waiting for transcription after speech ended */
  isTranscribing: boolean;
  /** Live interim transcript text */
  liveTranscript: string;
  /** Status text for display */
  statusText: string;
  /** Connect to voice bridge */
  connect: () => void;
  /** Disconnect from voice bridge */
  disconnect: () => void;
  /** Toggle microphone on/off */
  toggleMic: () => void;
}

interface UseVoiceChatProps {
  pairing: PairingState;
  sessionId: string | null;
  onTranscript: (text: string, clientMessageId: string) => void;
  onThinking: (clientMessageId: string) => void;
  onResponseChunk: (fullText: string, clientMessageId: string) => void;
  onResponse: (text: string, confidence: number, clientMessageId: string) => void;
  onStreamEvent: (eventType: string, payload: Record<string, unknown>) => void;
  onError: (message: string) => void;
}

export function useVoiceChat({
  pairing,
  sessionId,
  onTranscript,
  onThinking,
  onResponseChunk,
  onResponse,
  onStreamEvent,
  onError,
}: UseVoiceChatProps): VoiceChatState {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [statusText, setStatusText] = useState('Disconnected');

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioLevelSmoothRef = useRef(0);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopAudio();
      closeWebSocket();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const closeWebSocket = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
    setStatusText('Disconnected');
  }, []);

  const stopAudio = useCallback(() => {
    // Stop worklet
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({ type: 'stop' });
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    // Stop media stream
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
    // Close audio context
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    setMicEnabled(false);
    setAudioLevel(0);
    audioLevelSmoothRef.current = 0;
  }, []);

  const connect = useCallback(() => {
    if (!pairing.paired || !pairing.tunnelUrl || !pairing.pairingId) {
      onError('Not paired');
      return;
    }
    if (wsRef.current) return;

    setIsConnecting(true);
    setStatusText('Connecting...');

    // Build WebSocket URL from tunnel URL
    const wsUrl = pairing.tunnelUrl.replace(/^http/, 'ws') + '/relay/voice';
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // Send auth message
      ws.send(JSON.stringify({
        type: 'auth',
        pairingId: pairing.pairingId,
        sessionId: sessionId || pairing.mobileSessionId,
      }));
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;

      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      setIsConnecting(false);
      setStatusText('Disconnected');
      stopAudio();
      wsRef.current = null;
    };

    ws.onerror = () => {
      setIsConnecting(false);
      setStatusText('Connection failed');
    };
  }, [pairing, sessionId, onError, stopAudio]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleServerMessage = useCallback((msg: { type: string; [key: string]: unknown }) => {
    switch (msg.type) {
      case 'ready':
        setIsConnected(true);
        setIsConnecting(false);
        setStatusText('Connected');
        break;

      case 'speech-start':
        setIsSpeaking(true);
        break;

      case 'speech-end':
        setIsSpeaking(false);
        setIsTranscribing(true);
        setStatusText('Transcribing...');
        break;

      case 'transcript-interim':
        setIsTranscribing(false);
        setLiveTranscript(msg.text as string);
        setStatusText('Heard you...');
        break;

      case 'transcript': {
        const text = msg.text as string;
        const cmid = msg.client_message_id as string;
        setLiveTranscript('');
        setIsTranscribing(false);
        setStatusText('Processing...');
        onTranscript(text, cmid);
        break;
      }

      case 'thinking':
        onThinking(msg.client_message_id as string);
        setStatusText('Thinking...');
        break;

      case 'response-chunk':
        onResponseChunk(msg.text as string, msg.client_message_id as string);
        setStatusText('Responding...');
        break;

      case 'response':
        onResponse(
          msg.text as string,
          (msg.confidence as number) ?? 0,
          msg.client_message_id as string,
        );
        setStatusText('Connected');
        break;

      case 'stream-event':
        onStreamEvent(
          msg.event_type as string,
          msg.payload as Record<string, unknown>,
        );
        break;

      case 'error':
        onError(msg.message as string);
        setStatusText('Error');
        setTimeout(() => setStatusText(isConnected ? 'Connected' : 'Disconnected'), 3000);
        break;
    }
  }, [onTranscript, onThinking, onResponseChunk, onResponse, onStreamEvent, onError, isConnected]);

  const startAudio = useCallback(async () => {
    try {
      // Request mic access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      // Create audio context — try 16kHz but browser may give us something else
      const ctx = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = ctx;

      // Load the worklet processor
      await ctx.audioWorklet.addModule('/audio-worklet-processor.js');

      const source = ctx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(ctx, 'audio-capture-processor');
      workletNodeRef.current = worklet;

      // Handle audio data from worklet
      worklet.port.onmessage = (e) => {
        if (e.data.type === 'audio') {
          // Update audio level with smoothing
          const rms = e.data.rms as number;
          audioLevelSmoothRef.current = audioLevelSmoothRef.current * 0.7 + rms * 0.3;
          setAudioLevel(Math.min(1, audioLevelSmoothRef.current * 8));

          // Send raw PCM to WebSocket
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(e.data.samples);
          }
        }
      };

      source.connect(worklet);
      // Don't connect worklet to destination (we don't want playback)

      setMicEnabled(true);
      setStatusText('Listening');

      // Tell server we're unmuted
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'unmute' }));
      }
    } catch (err: any) {
      onError(`Microphone error: ${err.message}`);
      stopAudio();
    }
  }, [onError, stopAudio]);

  const toggleMic = useCallback(() => {
    if (micEnabled) {
      stopAudio();
      setStatusText('Connected');
      // Tell server we're muted
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'mute' }));
      }
    } else {
      if (!isConnected) {
        onError('Not connected to voice bridge');
        return;
      }
      startAudio();
    }
  }, [micEnabled, isConnected, startAudio, stopAudio, onError]);

  const disconnect = useCallback(() => {
    stopAudio();
    closeWebSocket();
  }, [stopAudio, closeWebSocket]);

  return {
    isConnected,
    isConnecting,
    micEnabled,
    audioLevel,
    isSpeaking,
    isTranscribing,
    liveTranscript,
    statusText,
    connect,
    disconnect,
    toggleMic,
  };
}
