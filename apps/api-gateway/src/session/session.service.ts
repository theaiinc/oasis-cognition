import { Injectable } from '@nestjs/common';

export interface SessionConfig {
  autonomous_mode: boolean;
  autonomous_max_duration_hours: number;
}

@Injectable()
export class SessionConfigService {
  private readonly configBySession = new Map<string, SessionConfig>();

  /** Avoid spreading `undefined` onto stored config (would wipe fields). */
  setConfig(sessionId: string, config: Partial<SessionConfig>): void {
    const existing = this.configBySession.get(sessionId) ?? this.getDefault();
    const patch: Partial<SessionConfig> = {};
    if (config.autonomous_mode !== undefined) {
      patch.autonomous_mode = !!config.autonomous_mode;
    }
    if (config.autonomous_max_duration_hours !== undefined && config.autonomous_max_duration_hours !== null) {
      const n = Number(config.autonomous_max_duration_hours);
      if (Number.isFinite(n) && n > 0) {
        patch.autonomous_max_duration_hours = Math.min(24, Math.max(1, Math.floor(n)));
      }
    }
    this.configBySession.set(sessionId, { ...existing, ...patch });
  }

  getConfig(sessionId: string, context?: Record<string, any>): SessionConfig {
    const fromContextPatch: Partial<SessionConfig> = {};
    if (context?.autonomous_mode !== undefined) {
      fromContextPatch.autonomous_mode = !!context.autonomous_mode;
    }
    if (context?.autonomous_max_duration_hours !== undefined) {
      fromContextPatch.autonomous_max_duration_hours = SessionConfigService.normalizeHours(
        context.autonomous_max_duration_hours,
      );
    }
    const fromStore = this.configBySession.get(sessionId);
    const merged = { ...this.getDefault(), ...fromStore, ...fromContextPatch };
    return {
      autonomous_mode: !!merged.autonomous_mode,
      autonomous_max_duration_hours: SessionConfigService.normalizeHours(merged.autonomous_max_duration_hours),
    };
  }

  private static normalizeHours(raw: unknown): number {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return Math.min(24, Math.max(1, Math.floor(raw)));
    }
    if (raw != null) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) {
        return Math.min(24, Math.max(1, Math.floor(n)));
      }
    }
    return 6;
  }

  private getDefault(): SessionConfig {
    return {
      autonomous_mode: false,
      autonomous_max_duration_hours: 6,
    };
  }
}
