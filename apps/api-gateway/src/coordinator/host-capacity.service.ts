import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import type { HostCapacitySnapshot } from './coordinator.types';

const DEV_AGENT_URL = process.env.DEV_AGENT_URL || 'http://localhost:8008';
const CACHE_TTL_MS = parseInt(process.env.HOST_CAPACITY_CACHE_TTL_MS || '30000', 10);

@Injectable()
export class HostCapacityService {
  private readonly logger = new Logger(HostCapacityService.name);
  private cached: HostCapacitySnapshot | null = null;
  private cachedAt = 0;

  /**
   * Return a cached host-capacity snapshot (refetches from dev-agent when
   * cache is older than CACHE_TTL_MS). Falls back gracefully if dev-agent
   * is unreachable.
   */
  async getCapacity(): Promise<HostCapacitySnapshot> {
    const now = Date.now();
    if (this.cached && now - this.cachedAt < CACHE_TTL_MS) {
      return this.cached;
    }
    try {
      const res = await axios.get(
        `${DEV_AGENT_URL}/internal/dev-agent/host-capacity`,
        { timeout: 5000 },
      );
      const d: HostCapacitySnapshot = {
        ram_total_mb: res.data.ram_total_mb ?? 0,
        ram_free_mb: res.data.ram_free_mb ?? 0,
        disk_free_gb: res.data.disk_free_gb ?? 0,
        cpu_cores: res.data.cpu_cores ?? 1,
        gpu_vram_mb: res.data.gpu_vram_mb ?? null,
        npu_available: res.data.npu_available ?? false,
        fetched_at: res.data.fetched_at ?? new Date().toISOString(),
      };
      this.cached = d;
      this.cachedAt = now;
      return d;
    } catch (err: any) {
      this.logger.warn(`host capacity probe failed: ${err.message}`);
      // Return stale cache if available, otherwise minimal defaults.
      if (this.cached) return this.cached;
      return {
        ram_total_mb: 8192,
        ram_free_mb: 4096,
        disk_free_gb: 50,
        cpu_cores: 4,
        gpu_vram_mb: null,
        npu_available: false,
        fetched_at: new Date().toISOString(),
      };
    }
  }

  /** Force-invalidate the cache on the next call. */
  invalidate(): void {
    this.cached = null;
    this.cachedAt = 0;
  }
}
