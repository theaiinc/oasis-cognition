export interface InitiatePairingRequest {
  duration_hours?: number;
}

export interface InitiatePairingResponse {
  pairing_id: string;
  qr_url: string;
  expires_at: string;
  tunnel_url: string;
}

export interface CompletePairingRequest {
  pairing_id: string;
  mobile_half_key: string;
}

export interface CompletePairingResponse {
  mobile_session_id: string;
  expires_at: string;
}

export interface PairingStatusResponse {
  state: 'idle' | 'awaiting_mobile' | 'paired' | 'expired';
  pairing_id?: string;
  expires_at?: string;
  tunnel_url?: string;
  screen_share_granted?: boolean;
  last_tool_request?: {
    type: string;
    timestamp: string;
    status: string;
  } | null;
}

export interface ScreenAccessRequest {
  grant: boolean;
}
