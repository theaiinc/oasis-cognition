export interface ToolCallInfo {
  name: string;
  status: 'running' | 'completed';
}

export interface Message {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: string;
  confidence?: number;
  // Streaming state
  thinking?: string;
  thinkingDone?: boolean;
  toolCalls?: ToolCallInfo[];
  isStreaming?: boolean;
  /** Waiting in the outbox: not on the desktop yet. */
  pending?: boolean;
  /** Outbox id (also the client_message_id) of a message sent from this phone. */
  queueId?: string;
  /** What went wrong, shown under any text that already arrived. */
  error?: string;
}

export interface PairingParams {
  pairingId: string;
  desktopHalfKey: string;
  expiresEpoch: number;
  tunnelUrl: string;
}

export interface PairingState {
  paired: boolean;
  tunnelUrl: string | null;
  sessionKey: CryptoKey | null;
  pairingId: string | null;
  mobileSessionId: string | null;
  expiresAt: Date | null;
}

export interface EncryptedPayload {
  iv: string;
  ct: string;
  tag: string;
  pid: string;
}

export interface ChatSession {
  session_id: string;
  created_at: string;
  last_message_at?: string;
  message_count?: number;
  preview?: string;
}

export interface ProjectConfig {
  configured: boolean;
  project_name?: string;
  project_path?: string;
  project_type?: string;
  tech_stack?: string[];
  frameworks?: string[];
  project_id?: string;
}

