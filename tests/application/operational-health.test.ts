import { describe, expect, it, vi } from 'vitest';
import { OperationalHealthService } from '../../src/application/operational-health.js';

describe('OperationalHealthService', () => {
  it('reports ready only when every authoritative dependency is ready', async () => {
    const health = new OperationalHealthService(0, [{ name: 'postgresql', check: vi.fn(async () => undefined) }, { name: 'redis-workers', check: vi.fn(async () => undefined) }], { info: vi.fn() } as never);
    await expect(health.readiness()).resolves.toEqual({ ready: true, checks: { postgresql: 'ready', 'redis-workers': 'ready' } });
  });
  it('fails readiness without exposing dependency error details', async () => {
    const health = new OperationalHealthService(0, [{ name: 'rpc-1', check: vi.fn(async () => { throw new Error('secret endpoint'); }) }], { info: vi.fn() } as never);
    await expect(health.readiness()).resolves.toEqual({ ready: false, checks: { 'rpc-1': 'unavailable' } });
  });
});
