import { useState, useEffect, useRef, useCallback } from 'react';
import { Room, RoomEvent, Track, createLocalScreenTracks } from 'livekit-client';
import axios from 'axios';
import { useToast } from '@/hooks/use-toast';
import { getErrorMessage } from '@/lib/utils';
import { VOICE_AGENT_URL } from '@/lib/constants';
import type { Message, TimelineEvent } from '@/lib/types';

function getMediaStreamTrack(track: unknown): MediaStreamTrack | undefined {
  if (!track || typeof track !== 'object') return undefined;
  return (track as { mediaStreamTrack?: MediaStreamTrack }).mediaStreamTrack;
}

function stopTrack(track: unknown) {
  if (!track || typeof track !== 'object') return;
  const maybe = track as { stop?: () => void };
  if (typeof maybe.stop === 'function') maybe.stop();
}

interface UseVoiceConnectionProps {
  textSessionId: string;
  addMessage: (text: string, sender: Message['sender'], confidence?: string, isTranscript?: boolean, isQueued?: boolean, id?: string) => void;
  upsertAssistantMessage: (clientMessageId: string, text: string, confidence?: string) => void;
  flushQueueIfIdle: () => Promise<void>;
  setTimelineByClientMessageId: React.Dispatch<React.SetStateAction<Record<string, TimelineEvent[]>>>;
  setActiveClientMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setIsThinking: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useVoiceConnection({
  textSessionId,
  addMessage,
  upsertAssistantMessage,
  flushQueueIfIdle,
  setTimelineByClientMessageId,
  setActiveClientMessageId,
  setMessages,
  setIsThinking,
}: UseVoiceConnectionProps) {
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [silenceSeconds, setSilenceSeconds] = useState(0);
  const [statusText, setStatusText] = useState('Idle');
  const [liveTranscript, setLiveTranscript] = useState('');
  const roomRef = useRef<Room | null>(null);
  const audioIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcribingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressTranscriptionRef = useRef(false);
  const silenceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wasSpeakingRef = useRef(false);
  // Always-current session ID ref so reconnect handlers never use a stale closure value
  const sessionIdRef = useRef(textSessionId);
  sessionIdRef.current = textSessionId;
  const { toast } = useToast();

  useEffect(() => {
    if (isSpeaking) {
      wasSpeakingRef.current = true;
      setIsTranscribing(false);
      if (transcribingTimeoutRef.current) { clearTimeout(transcribingTimeoutRef.current); transcribingTimeoutRef.current = null; }
      if (silenceIntervalRef.current) { clearInterval(silenceIntervalRef.current); silenceIntervalRef.current = null; }
      setSilenceSeconds(0);
    } else if (wasSpeakingRef.current) {
      wasSpeakingRef.current = false;
      setIsTranscribing(true);
      setSilenceSeconds(0);
      silenceIntervalRef.current = setInterval(() => setSilenceSeconds((prev) => prev + 0.25), 250);
      transcribingTimeoutRef.current = setTimeout(() => {
        setIsTranscribing(false);
        setLiveTranscript('');
        setSilenceSeconds(0);
        if (silenceIntervalRef.current) { clearInterval(silenceIntervalRef.current); silenceIntervalRef.current = null; }
      }, 30_000);
    }
    return () => {
      if (transcribingTimeoutRef.current) clearTimeout(transcribingTimeoutRef.current);
      if (silenceIntervalRef.current) clearInterval(silenceIntervalRef.current);
    };
  }, [isSpeaking]);

  const handleConnect = useCallback(async () => {
    if (isConnected) {
      roomRef.current?.disconnect();
      if (audioIntervalRef.current) clearInterval(audioIntervalRef.current);
      return;
    }
    setIsConnecting(true);
    setStatusText('Connecting...');
    const roomName = 'oasis-voice';
    const participantName = `user-${Math.floor(Math.random() * 1000)}`;
    const httpTimeoutMs = 25_000;
    try {
      await axios.post(`${VOICE_AGENT_URL}/join?room_name=${roomName}&session_id=${encodeURIComponent(sessionIdRef.current)}`, undefined, { timeout: httpTimeoutMs });
      const res = await axios.post(`${VOICE_AGENT_URL}/token?room_name=${roomName}&participant_name=${participantName}`, undefined, { timeout: httpTimeoutMs });
      const { url, token } = res.data;
      const room = new Room({ adaptiveStream: true });
      roomRef.current = room;

      room.on(RoomEvent.Connected, () => {
        setIsConnected(true);
        setIsConnecting(false);
        setStatusText('Connected');
        addMessage('Connected to Oasis reasoning session.', 'system');
        const sendSetSession = () => {
          try {
            room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: 'set_session', session_id: sessionIdRef.current })), { reliable: true });
          } catch { /* best effort */ }
        };
        sendSetSession();
        setTimeout(sendSetSession, 1000);
      });

      let isReconnecting = false;
      room.on(RoomEvent.Disconnected, () => {
        setIsConnected(false);
        setMicEnabled(false);
        setIsSharing(false);
        setIsSpeaking(false);
        setAudioLevel(0);
        setLiveTranscript('');
        if (audioIntervalRef.current) clearInterval(audioIntervalRef.current);
        if (isReconnecting) return;
        isReconnecting = true;
        const maxRetries = 5;
        let attempt = 0;
        const tryReconnect = async () => {
          attempt++;
          if (attempt > maxRetries) {
            setStatusText('Disconnected');
            isReconnecting = false;
            addMessage('Connection lost. Click the connect button to retry.', 'system');
            return;
          }
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          setStatusText(`Reconnecting (${attempt}/${maxRetries})...`);
          await new Promise(r => setTimeout(r, delay));
          try {
            await axios.post(`${VOICE_AGENT_URL}/join?room_name=${roomName}&session_id=${encodeURIComponent(sessionIdRef.current)}`);
            const tokenRes = await axios.post(`${VOICE_AGENT_URL}/token?room_name=${roomName}&participant_name=${participantName}`);
            await room.connect(tokenRes.data.url, tokenRes.data.token);
            setIsConnected(true);
            setStatusText('Connected');
            isReconnecting = false;
            try {
              room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: 'set_session', session_id: sessionIdRef.current })), { reliable: true });
            } catch { /* best effort */ }
            audioIntervalRef.current = setInterval(() => {
              if (room.state === 'connected') {
                const level = room.localParticipant.audioLevel || 0;
                setAudioLevel(level);
                if (level > 0.02) setIsSpeaking(true);
              } else {
                setAudioLevel(0);
                setIsSpeaking(false);
              }
            }, 80);
          } catch {
            void tryReconnect();
          }
        };
        void tryReconnect();
      });

      room.on(RoomEvent.Reconnecting, () => setStatusText('Reconnecting...'));
      room.on(RoomEvent.Reconnected, () => {
        setStatusText('Connected');
        setIsConnected(true);
        try {
          room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: 'set_session', session_id: sessionIdRef.current })), { reliable: true });
        } catch { /* best effort */ }
      });

      room.on(RoomEvent.DataReceived, (payload: Uint8Array | ArrayBuffer | unknown) => {
        try {
          const bytes = payload instanceof ArrayBuffer ? new Uint8Array(payload)
            : ArrayBuffer.isView(payload) ? new Uint8Array((payload as Uint8Array).buffer, (payload as Uint8Array).byteOffset, (payload as Uint8Array).byteLength)
            : payload instanceof Uint8Array ? payload : null;
          if (!bytes?.length) return;
          const data = JSON.parse(new TextDecoder().decode(bytes)) as { type?: string; text?: string; confidence?: string; client_message_id?: string };
          // Skip transcript/response processing while suppressed (e.g. during voice enrollment)
          if (suppressTranscriptionRef.current && (data.type === 'oasis-transcript-interim' || data.type === 'oasis-transcript' || data.type === 'oasis-thinking' || data.type === 'oasis-response')) return;
          if (data.type === 'oasis-transcript-interim') {
            const text = (data.text ?? '').trim();
            if (text) {
              setLiveTranscript('');
              setIsTranscribing(false);
              setSilenceSeconds(0);
              if (transcribingTimeoutRef.current) { clearTimeout(transcribingTimeoutRef.current); transcribingTimeoutRef.current = null; }
              if (silenceIntervalRef.current) { clearInterval(silenceIntervalRef.current); silenceIntervalRef.current = null; }
              addMessage(text, 'user', undefined, true, false, data.client_message_id);
              setIsThinking(true);
              if (data.client_message_id) setActiveClientMessageId(data.client_message_id);
            } else {
              setLiveTranscript(data.text || '');
            }
          } else if (data.type === 'oasis-transcript') {
            setLiveTranscript('');
            setIsTranscribing(false);
            setSilenceSeconds(0);
            if (transcribingTimeoutRef.current) { clearTimeout(transcribingTimeoutRef.current); transcribingTimeoutRef.current = null; }
            if (silenceIntervalRef.current) { clearInterval(silenceIntervalRef.current); silenceIntervalRef.current = null; }
            const text = (data.text ?? '').trim();
            if (text && data.client_message_id) {
              setMessages(prev => {
                const idx = prev.findIndex(m => m.id === data.client_message_id);
                if (idx >= 0) {
                  const updated = [...prev];
                  updated[idx] = { ...updated[idx], text };
                  return updated;
                }
                return [...prev, { id: data.client_message_id!, text, sender: 'user' as const, timestamp: new Date(), isTranscript: true }];
              });
              setIsThinking(true);
              setActiveClientMessageId(data.client_message_id);
            } else if (text) {
              addMessage(text, 'user', undefined, true, false, data.client_message_id);
              setIsThinking(true);
            }
          } else if (data.type === 'oasis-thinking') {
            setIsThinking(true);
            setIsTranscribing(false);
            setSilenceSeconds(0);
            setLiveTranscript('');
            if (transcribingTimeoutRef.current) { clearTimeout(transcribingTimeoutRef.current); transcribingTimeoutRef.current = null; }
            if (silenceIntervalRef.current) { clearInterval(silenceIntervalRef.current); silenceIntervalRef.current = null; }
            if (data.client_message_id) {
              setActiveClientMessageId(data.client_message_id);
              setTimelineByClientMessageId(prev => ({
                ...prev,
                [data.client_message_id!]: [...(prev[data.client_message_id!] || []), {
                  event_type: 'VoiceRequestSent',
                  timestamp: new Date().toISOString(),
                  payload: { client_message_id: data.client_message_id },
                }],
              }));
            }
          } else if (data.type === 'oasis-response') {
            setIsThinking(false);
            if (data.client_message_id) {
              upsertAssistantMessage(data.client_message_id, data.text ?? '', data.confidence);
            } else {
              addMessage(data.text ?? '', 'assistant', data.confidence);
            }
            queueMicrotask(() => { void flushQueueIfIdle(); });
          }
        } catch (e) {
          console.error('Failed to parse LiveKit data message', e);
        }
      });

      let silenceCount = 0;
      audioIntervalRef.current = setInterval(() => {
        if (suppressTranscriptionRef.current) return;
        if (room.state === 'connected') {
          const level = room.localParticipant.audioLevel || 0;
          setAudioLevel(level);
          if (level > 0.02) { silenceCount = 0; setIsSpeaking(true); }
          else { silenceCount++; if (silenceCount >= 5) setIsSpeaking(false); }
        } else {
          setAudioLevel(0);
          silenceCount = 0;
          setIsSpeaking(false);
        }
      }, 80);

      const connectTimeoutMs = 60_000;
      await Promise.race([
        room.connect(url, token),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('LiveKit connection timed out')), connectTimeoutMs);
        }),
      ]);
      // Connected handler usually clears this; if event ordering ever lags, avoid stuck "Connecting..."
      if (room.state === 'connected') {
        setIsConnecting(false);
      }
    } catch (error: unknown) {
      try {
        roomRef.current?.disconnect();
      } catch {
        /* ignore */
      }
      roomRef.current = null;
      toast({ title: "Connection Error", description: getErrorMessage(error), variant: "destructive" });
      setIsConnecting(false);
      setStatusText('Connection Failed');
    }
  }, [isConnected, addMessage, upsertAssistantMessage, flushQueueIfIdle, toast, setTimelineByClientMessageId, setActiveClientMessageId, setMessages, setIsThinking]);

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !micEnabled;
    try {
      if (next) {
        await room.localParticipant.setMicrophoneEnabled(true);
        setStatusText('Listening');
      } else {
        await room.localParticipant.setMicrophoneEnabled(false);
        for (const pub of Array.from(room.localParticipant.trackPublications.values())) {
          if (pub.source === Track.Source.Microphone && pub.track) {
            try {
              await room.localParticipant.unpublishTrack(pub.track);
              const mediaTrack = getMediaStreamTrack(pub.track);
              if (mediaTrack?.stop) mediaTrack.stop();
              else stopTrack(pub.track);
            } catch { /* best effort */ }
          }
        }
        setStatusText('Connected');
        setIsSpeaking(false);
        setAudioLevel(0);
        setLiveTranscript('');
      }
      setMicEnabled(next);
    } catch (e: unknown) {
      toast({ title: "Microphone Error", description: getErrorMessage(e), variant: "destructive" });
    }
  }, [micEnabled, toast]);

  const toggleScreenShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      if (isSharing) {
        for (const pub of Array.from(room.localParticipant.trackPublications.values())) {
          if (pub.source === Track.Source.ScreenShare || pub.trackName === 'screen_share') {
            try {
              if (pub.track) {
                await room.localParticipant.unpublishTrack(pub.track);
                const mediaTrack = getMediaStreamTrack(pub.track);
                if (mediaTrack?.stop) mediaTrack.stop();
                else stopTrack(pub.track);
              }
            } catch { /* best effort */ }
          }
        }
        setIsSharing(false);
      } else {
        const tracks = await createLocalScreenTracks();
        if (tracks.length > 0) {
          await room.localParticipant.publishTrack(tracks[0], { name: 'screen_share' });
          setIsSharing(true);
          tracks[0].on('ended', () => setIsSharing(false));
        }
      }
    } catch (e: unknown) {
      setIsSharing(false);
      toast({ title: "Screen Share Error", description: getErrorMessage(e), variant: "destructive" });
    }
  }, [isSharing, toast]);

  const setSuppressTranscription = useCallback((suppress: boolean) => {
    suppressTranscriptionRef.current = suppress;
  }, []);

  // Enable/disable LiveKit mic without changing micEnabled state or chat UI
  const setMicSilent = useCallback(async (on: boolean) => {
    const room = roomRef.current;
    if (!room) return;
    try {
      if (on) {
        suppressTranscriptionRef.current = true;
        await room.localParticipant.setMicrophoneEnabled(true);
      } else {
        await room.localParticipant.setMicrophoneEnabled(false);
        for (const pub of Array.from(room.localParticipant.trackPublications.values())) {
          if (pub.source === Track.Source.Microphone && pub.track) {
            try {
              await room.localParticipant.unpublishTrack(pub.track);
              const mediaTrack = getMediaStreamTrack(pub.track);
              if (mediaTrack?.stop) mediaTrack.stop();
              else stopTrack(pub.track);
            } catch { /* best effort */ }
          }
        }
        suppressTranscriptionRef.current = false;
      }
    } catch { /* best effort */ }
  }, []);

  // When session ID changes (e.g. new chat), re-sync the voice agent so it doesn't create a separate session
  useEffect(() => {
    const room = roomRef.current;
    if (!room || room.state !== 'connected') return;
    try {
      room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify({ type: 'set_session', session_id: textSessionId })),
        { reliable: true },
      );
    } catch { /* best effort */ }
  }, [textSessionId]);

  return {
    isConnected,
    isConnecting,
    micEnabled,
    isSharing,
    statusText,
    audioLevel,
    isSpeaking,
    isTranscribing,
    silenceSeconds,
    liveTranscript,
    handleConnect,
    toggleMic,
    toggleScreenShare,
    setSuppressTranscription,
    setMicSilent,
  };
}
