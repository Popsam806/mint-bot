import { describe, expect, it, vi } from 'vitest';
import { ApplicationRuntime } from '../../src/application/runtime.js';
import { parseEnvironment } from '../../src/config/env.js';

const component = (onStart?: () => void) => ({
  start: vi.fn(async () => { onStart?.(); }),
  stop: vi.fn(async () => undefined),
});

function setup(options: { telegram?: 'success' | 'failure'; onPendingStart?: () => void; redisFailure?: boolean; recoveryFailure?: boolean; backgroundWorkers?: boolean } = {}) {
  const postgres = { query: vi.fn(async () => ({ rows: [{ '?column?': 1 }] })), end: vi.fn(async () => undefined) };
  const redis = { ping: options.redisFailure ? vi.fn(async () => { throw new Error('redis unavailable'); }) : vi.fn(async () => 'PONG'), quit: vi.fn(async () => 'OK') };
  const monitoring = component();
  const pendingMonitoring = component(options.onPendingStart);
  const confirmation = component();
  const recovery = component();
  const backgroundWorkers = options.backgroundWorkers ? component() : undefined;
  if (options.recoveryFailure) recovery.start.mockRejectedValueOnce(new Error('recovery unavailable'));
  const telegram = options.telegram ? {
    launch: options.telegram === 'failure' ? vi.fn(async () => { throw new Error('telegram unavailable'); }) : vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } : undefined;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const runtime = new ApplicationRuntime({ postgres, redis, monitoring, pendingMonitoring, confirmation, recovery, backgroundWorkers, telegram, automaticExecutionEnabled: true, logger });
  return { runtime, postgres, redis, monitoring, pendingMonitoring, confirmation, recovery, backgroundWorkers, telegram, logger };
}

describe('ApplicationRuntime', () => {
  it('keeps monitoring and AUTO execution active when Telegram launch fails', async () => {
    const automaticExecution = vi.fn();
    const test = setup({ telegram: 'failure', onPendingStart: automaticExecution });
    await test.runtime.start();

    expect(test.monitoring.start).toHaveBeenCalledOnce();
    expect(test.pendingMonitoring.start).toHaveBeenCalledOnce();
    expect(automaticExecution).toHaveBeenCalledOnce();
    expect(test.monitoring.stop).not.toHaveBeenCalled();
    expect(test.pendingMonitoring.stop).not.toHaveBeenCalled();
    expect(test.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), 'Telegram unavailable; worker remains active');
  });

  it('starts the worker without a Telegram token', async () => {
    const configuration = parseEnvironment({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://localhost/test', REDIS_URL: 'redis://localhost:6379' });
    expect(configuration.TELEGRAM_BOT_TOKEN).toBeUndefined();
    const test = setup(); await test.runtime.start();
    expect(test.monitoring.start).toHaveBeenCalledOnce();
    expect(test.logger.warn).toHaveBeenCalledWith('Telegram unavailable; TELEGRAM_BOT_TOKEN is not configured');
  });

  it('starts Telegram normally when configured', async () => {
    const test = setup({ telegram: 'success' }); await test.runtime.start();
    expect(test.telegram?.launch).toHaveBeenCalledOnce();
    expect(test.logger.info).toHaveBeenCalledWith('Telegram ready');
  });

  it('checks PostgreSQL and Redis readiness before starting worker components', async () => {
    const test = setup(); await test.runtime.start();
    expect(test.postgres.query).toHaveBeenCalledWith('SELECT 1');
    expect(test.redis.ping).toHaveBeenCalledOnce();
    expect(test.postgres.query.mock.invocationCallOrder[0]).toBeLessThan(test.monitoring.start.mock.invocationCallOrder[0]!);
    expect(test.redis.ping.mock.invocationCallOrder[0]).toBeLessThan(test.monitoring.start.mock.invocationCallOrder[0]!);
    expect(test.recovery.start.mock.invocationCallOrder[0]).toBeLessThan(test.pendingMonitoring.start.mock.invocationCallOrder[0]!);
  });

  it('keeps pending detection running but blocks AUTO readiness when startup recovery fails', async () => {
    const test = setup({ recoveryFailure: true }); await test.runtime.start();
    expect(test.pendingMonitoring.start).toHaveBeenCalledOnce();
    expect(test.logger.warn).toHaveBeenCalledWith('Automatic execution unavailable because durable recovery failed');
  });

  it('continues the worker when unused Redis is unavailable', async () => {
    const test = setup({ redisFailure: true }); await test.runtime.start();
    expect(test.monitoring.start).toHaveBeenCalledOnce();
    expect(test.pendingMonitoring.start).toHaveBeenCalledOnce();
  });

  it('keeps monitoring active and does not start queue workers while Redis is unavailable', async () => {
    const test = setup({ redisFailure: true, backgroundWorkers: true }); await test.runtime.start();
    expect(test.monitoring.start).toHaveBeenCalledOnce(); expect(test.pendingMonitoring.start).toHaveBeenCalledOnce();
    expect(test.backgroundWorkers?.start).not.toHaveBeenCalled(); await test.runtime.shutdown('test');
  });

  it('starts pending monitoring even when confirmed monitoring fails', async () => {
    const test = setup(); test.monitoring.start.mockRejectedValueOnce(new Error('confirmed monitor unavailable'));
    await test.runtime.start();
    expect(test.pendingMonitoring.start).toHaveBeenCalledOnce();
    expect(test.confirmation.start).toHaveBeenCalledOnce();
  });

  it('closes every component and resource during shutdown', async () => {
    const test = setup({ telegram: 'success' }); await test.runtime.start(); await test.runtime.shutdown('test');
    expect(test.telegram?.stop).toHaveBeenCalledWith('test');
    expect(test.confirmation.stop).toHaveBeenCalledOnce();
    expect(test.recovery.stop).toHaveBeenCalledOnce();
    expect(test.pendingMonitoring.stop).toHaveBeenCalledOnce();
    expect(test.monitoring.stop).toHaveBeenCalledOnce();
    expect(test.redis.quit).toHaveBeenCalledOnce();
    expect(test.postgres.end).toHaveBeenCalledOnce();
  });

  it('continues shutting down other resources when one stop fails', async () => {
    const test = setup({ telegram: 'success' }); await test.runtime.start();
    test.confirmation.stop.mockRejectedValueOnce(new Error('stop failed'));
    await test.runtime.shutdown('test');
    expect(test.pendingMonitoring.stop).toHaveBeenCalledOnce();
    expect(test.monitoring.stop).toHaveBeenCalledOnce();
    expect(test.redis.quit).toHaveBeenCalledOnce();
    expect(test.postgres.end).toHaveBeenCalledOnce();
    expect(test.logger.error).toHaveBeenCalledWith({ failures: 1 }, 'Some components failed during shutdown');
  });
});
