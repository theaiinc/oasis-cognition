import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { SessionService } from '../session/session.service';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8000';
const TRANSCRIPTION_URL = process.env.TRANSCRIPTION_URL || 'http://localhost:8099/transcribe';
const TRANSCRIPT_CLEANUP_URL = process.env.TRANSCRIPT_CLEANUP_URL || 'http://localhost:8005/internal/response/transcript-cleanup';

// Timeline event types worth forwarding to mobile (same as relay.service.ts)
const FORWARD_EVENT_TYPES = new Set([
  'ResponseChunkGenerated',
  'ToolCallStarted',
  'ToolCallCompleted',
  'ToolReasoningChunkGenerated',
  'ThoughtChunkGenerated',
  'ThoughtLayerGenerated',
  'ThoughtsValidated',
]);

// VAD constants
const VAD_FRAME_SIZE = 1600; // 100ms at 16kHz
const NOISE_FLOOR_ALPHA = 0.02;
const SPEECH_MULTIPLIER = 3.5;
const MIN_ENERGY_THRESHOLD = 0.008;
const MAX_ENERGY_THRESHOLD = 0.06;
const MIN_SPEECH_FRAMES = 3;
const SILENCE_TIMEOUT_MS = 5000;
const MAX_UTTERANCE_MS = 60000;

// Hallucination filter patterns
const HALLUCINATION_PATTERNS = [
  /^\s*$/,
  /^(thank you|thanks|bye|goodbye|subscribe|like|comment)\s*[.!]?\s*$/i,
  /^\[.*\]\s*$/,               // [music], [applause], etc.
  /^\.+$/,                      // just dots
  /^(um|uh|hmm|huh|ah|oh)\s*[.!]?\s*$/i,
];

function isHallucination(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  // Single word utterances (after removing punctuation)
  const words = trimmed.replace(/[^\w\s]/g, '').trim().split(/\s+/);
  if (words.length <= 1 && words[0].length < 10) return true;
  return HALLUCINATION_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Computes RMS energy for a Float32 PCM buffer.
 */
function computeRMS(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

interface VoiceSessionConfig {
  ws: WebSocket;
  pairingId: string;
  mobileSessionId: string;
  sessionService: SessionService;
}

class VoiceSession {
  private ws: WebSocket;
  private pairingId: string;
  private mobileSessionId: string;
  private sessionService: SessionService;

  // Audio buffering
  private audioBuffer: Float32Array = new Float32Array(0);

  // VAD state
  private noiseFloor = 0.01;
  private isSpeaking = false;
  private consecutiveSpeechFrames = 0;
  private consecutiveSilenceFrames = 0;
  private speechStartTime = 0;
  private lastSpeechTime = 0;
  private utteranceFrames: Float32Array[] = [];
  private muted = false;

  // Processing lock to avoid overlapping transcriptions
  private processing = false;

  constructor(config: VoiceSessionConfig) {
    this.ws = config.ws;
    this.pairingId = config.pairingId;
    this.mobileSessionId = config.mobileSessionId;
    this.sessionService = config.sessionService;

    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.handleAudio(data as Buffer);
      } else {
        this.handleControl(data.toString());
      }
    });

    this.ws.on('close', () => {
      console.log(`[VoiceBridge] Session closed: ${this.pairingId}`);
      this.cleanup();
    });

    this.ws.on('error', (err) => {
      console.error(`[VoiceBridge] WebSocket error:`, err.message);
    });
  }

  private send(msg: Record<string, any>): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleControl(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.send({ type: 'error', message: 'Invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'auth':
        this.handleAuth(msg);
        break;
      case 'mute':
        this.muted = true;
        break;
      case 'unmute':
        this.muted = false;
        break;
      default:
        this.send({ type: 'error', message: `Unknown control type: ${msg.type}` });
    }
  }

  private handleAuth(msg: { pairingId?: string; sessionId?: string }): void {
    if (!msg.pairingId) {
      this.send({ type: 'error', message: 'Missing pairingId' });
      this.ws.close(4001, 'Missing pairingId');
      return;
    }

    // Validate pairing via SessionService
    const session = this.sessionService.getActiveSession();
    if (!session || session.pairingId !== msg.pairingId) {
      this.send({ type: 'error', message: 'Invalid or expired pairing' });
      this.ws.close(4001, 'Invalid pairing');
      return;
    }

    this.pairingId = msg.pairingId;
    this.mobileSessionId = msg.sessionId || session.mobileSessionId;

    console.log(`[VoiceBridge] Authenticated: pairing=${this.pairingId}`);
    this.send({ type: 'ready' });
  }

  private handleAudio(data: Buffer): void {
    if (this.muted) return;

    // Validate auth happened
    if (!this.pairingId) {
      this.send({ type: 'error', message: 'Not authenticated — send auth first' });
      return;
    }

    // Convert raw bytes to Float32Array (PCM Float32 LE)
    const float32 = new Float32Array(
      data.buffer,
      data.byteOffset,
      data.byteLength / 4,
    );

    // Append to buffer
    const newBuffer = new Float32Array(this.audioBuffer.length + float32.length);
    newBuffer.set(this.audioBuffer);
    newBuffer.set(float32, this.audioBuffer.length);
    this.audioBuffer = newBuffer;

    // Process frames
    this.processFrames();
  }

  private processFrames(): void {
    while (this.audioBuffer.length >= VAD_FRAME_SIZE) {
      const frame = this.audioBuffer.slice(0, VAD_FRAME_SIZE);
      this.audioBuffer = this.audioBuffer.slice(VAD_FRAME_SIZE);
      this.processVADFrame(frame);
    }
  }

  private processVADFrame(frame: Float32Array): void {
    const energy = computeRMS(frame);
    const now = Date.now();

    // Update adaptive noise floor (EMA)
    if (!this.isSpeaking) {
      this.noiseFloor = this.noiseFloor * (1 - NOISE_FLOOR_ALPHA) + energy * NOISE_FLOOR_ALPHA;
    }

    // Compute dynamic threshold
    const threshold = Math.min(
      Math.max(this.noiseFloor * SPEECH_MULTIPLIER, MIN_ENERGY_THRESHOLD),
      MAX_ENERGY_THRESHOLD,
    );

    const isSpeechFrame = energy > threshold;

    if (isSpeechFrame) {
      this.consecutiveSpeechFrames++;
      this.consecutiveSilenceFrames = 0;

      if (!this.isSpeaking && this.consecutiveSpeechFrames >= MIN_SPEECH_FRAMES) {
        // Speech started
        this.isSpeaking = true;
        this.speechStartTime = now;
        this.lastSpeechTime = now;
        this.utteranceFrames = [];
        this.send({ type: 'speech-start' });
      }

      if (this.isSpeaking) {
        this.lastSpeechTime = now;
      }
    } else {
      this.consecutiveSilenceFrames++;
      if (!this.isSpeaking) {
        this.consecutiveSpeechFrames = 0;
      }
    }

    // Accumulate audio while speaking
    if (this.isSpeaking) {
      this.utteranceFrames.push(frame);

      // Check max utterance duration
      if (now - this.speechStartTime > MAX_UTTERANCE_MS) {
        this.finalizeUtterance();
        return;
      }

      // Check silence timeout
      if (now - this.lastSpeechTime > SILENCE_TIMEOUT_MS) {
        this.finalizeUtterance();
        return;
      }
    }
  }

  private finalizeUtterance(): void {
    if (!this.isSpeaking || this.utteranceFrames.length === 0) return;

    const frames = this.utteranceFrames;
    this.isSpeaking = false;
    this.consecutiveSpeechFrames = 0;
    this.consecutiveSilenceFrames = 0;
    this.utteranceFrames = [];

    this.send({ type: 'speech-end' });

    // Merge frames into single buffer
    const totalSamples = frames.reduce((sum, f) => sum + f.length, 0);
    const merged = new Float32Array(totalSamples);
    let offset = 0;
    for (const f of frames) {
      merged.set(f, offset);
      offset += f.length;
    }

    // Process asynchronously
    if (!this.processing) {
      this.processing = true;
      this.processUtterance(merged).finally(() => {
        this.processing = false;
      });
    }
  }

  private async processUtterance(audio: Float32Array): Promise<void> {
    const clientMessageId = uuidv4();

    try {
      // 1. Transcribe via MLX
      const base64Audio = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength).toString('base64');

      const transcriptionResponse = await axios.post(
        TRANSCRIPTION_URL,
        {
          audio_data: base64Audio,
          sample_rate: 16000,
          format: 'float32',
        },
        { timeout: 30_000 },
      );

      const rawTranscript: string = transcriptionResponse.data?.text?.trim() || '';
      console.log(`[VoiceBridge] Raw transcript: "${rawTranscript}"`);

      if (!rawTranscript || isHallucination(rawTranscript)) {
        console.log(`[VoiceBridge] Filtered hallucination: "${rawTranscript}"`);
        return;
      }

      // Send interim transcript
      this.send({
        type: 'transcript-interim',
        text: rawTranscript,
        client_message_id: clientMessageId,
      });

      // 2. Transcript cleanup
      let cleanedTranscript = rawTranscript;
      try {
        const cleanupResponse = await axios.post(
          TRANSCRIPT_CLEANUP_URL,
          { transcript: rawTranscript },
          { timeout: 10_000 },
        );
        cleanedTranscript = cleanupResponse.data?.cleaned || cleanupResponse.data?.text || rawTranscript;
      } catch (err: any) {
        console.warn(`[VoiceBridge] Transcript cleanup failed, using raw:`, err.message);
      }

      console.log(`[VoiceBridge] Cleaned transcript: "${cleanedTranscript}"`);

      // Send cleaned transcript
      this.send({
        type: 'transcript',
        text: cleanedTranscript,
        client_message_id: clientMessageId,
      });

      // 3. Send thinking indicator
      this.send({
        type: 'thinking',
        client_message_id: clientMessageId,
      });

      // 4. Call interaction API and subscribe to SSE timeline
      await this.callInteraction(cleanedTranscript, clientMessageId);
    } catch (err: any) {
      console.error(`[VoiceBridge] Utterance processing error:`, err.message);
      this.send({
        type: 'error',
        message: `Processing failed: ${err.message}`,
        client_message_id: clientMessageId,
      });
    }
  }

  private async callInteraction(transcript: string, clientMessageId: string): Promise<void> {
    const interactionBody = {
      message: transcript,
      session_id: this.mobileSessionId,
      context: {
        source: 'mobile-voice',
        client_message_id: clientMessageId,
      },
    };

    // Start SSE timeline listener BEFORE sending the interaction
    const sseCleanup = this.subscribeToTimeline(clientMessageId);

    try {
      const response = await axios.post(
        `${GATEWAY_URL}/api/v1/interaction`,
        interactionBody,
        {
          responseType: 'stream',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/x-ndjson',
          },
          timeout: 300_000,
        },
      );

      let fullResponse = '';

      await new Promise<void>((resolve, reject) => {
        let buffer = '';

        response.data.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
              const parsed = JSON.parse(trimmed);

              // Forward response chunks
              if (parsed.response || parsed.text) {
                const text = parsed.response || parsed.text || '';
                fullResponse += text;
                this.send({
                  type: 'response-chunk',
                  text,
                  client_message_id: clientMessageId,
                });
              }

              // Check for final response
              if (parsed.status === 'completed' || parsed.done) {
                if (parsed.response) {
                  fullResponse = parsed.response;
                }
              }
            } catch {
              // Skip unparseable lines
            }
          }
        });

        response.data.on('end', () => {
          // Process remaining buffer
          if (buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer.trim());
              if (parsed.response || parsed.text) {
                fullResponse = parsed.response || parsed.text || fullResponse;
              }
            } catch { /* ignore */ }
          }
          resolve();
        });

        response.data.on('error', (err: Error) => reject(err));
      });

      // Send final response
      this.send({
        type: 'response',
        text: fullResponse,
        confidence: 1.0,
        client_message_id: clientMessageId,
      });
    } finally {
      sseCleanup();
    }
  }

  /**
   * Subscribe to the gateway SSE timeline for streaming events.
   * Reuses the same pattern from relay.service.ts.
   */
  private subscribeToTimeline(clientMessageId: string): () => void {
    let req: http.ClientRequest | null = null;
    let closed = false;

    const url = new URL(`${GATEWAY_URL}/api/v1/events/timeline`);
    url.searchParams.set('session_id', this.mobileSessionId);
    url.searchParams.set('backlog', '0');

    req = http.get(url.toString(), (res) => {
      let sseBuffer = '';

      res.on('data', (chunk: Buffer) => {
        if (closed) return;
        sseBuffer += chunk.toString();
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data) continue;

          try {
            const event = JSON.parse(data);
            if (!FORWARD_EVENT_TYPES.has(event.event_type)) continue;

            this.send({
              type: 'stream-event',
              event_type: event.event_type,
              payload: event.payload || {},
              client_message_id: clientMessageId,
            });
          } catch {
            // Skip unparseable events
          }
        }
      });

      res.on('error', () => { /* ignore SSE errors */ });
    });

    req.on('error', () => { /* ignore connection errors */ });

    return () => {
      closed = true;
      if (req) {
        req.destroy();
        req = null;
      }
    };
  }

  private cleanup(): void {
    this.audioBuffer = new Float32Array(0);
    this.utteranceFrames = [];
    this.isSpeaking = false;
  }
}

/**
 * Sets up the WebSocket voice bridge on the existing HTTP server.
 * Handles upgrade requests for path `/relay/voice`.
 */
export function setupVoiceBridge(server: http.Server, sessionService: SessionService): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', `http://${request.headers.host}`);

    if (url.pathname !== '/relay/voice') {
      // Not our path — let other handlers deal with it or reject
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      console.log(`[VoiceBridge] New connection from ${request.socket.remoteAddress}`);

      new VoiceSession({
        ws,
        pairingId: '',      // Set during auth
        mobileSessionId: '', // Set during auth
        sessionService,
      });
    });
  });

  console.log('[VoiceBridge] WebSocket voice bridge ready on /relay/voice');
}
