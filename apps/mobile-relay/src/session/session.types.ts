export interface MobilePairingSession {
  pairingId: string;
  sessionKey: Buffer | null;
  desktopHalf: Buffer;
  tunnelUrl: string;
  qrUrl: string;
  expiresAt: Date;
  durationHours: number;
  createdAt: Date;
  mobilePaired: boolean;
  mobileSessionId: string;
  screenShareGranted: boolean;
  lastToolRequest: ToolRequestInfo | null;
}

export interface ToolRequestInfo {
  type: string;
  timestamp: Date;
  status: 'pending' | 'completed' | 'failed';
}

export type PairingState = 'idle' | 'awaiting_mobile' | 'paired' | 'expired';
