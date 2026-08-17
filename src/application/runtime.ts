export interface LifecycleComponent {
  start(): Promise<void>;
  stop(): Promise<void> | void;
}

export interface TelegramComponent {
  launch(): Promise<void>;
  stop(reason?: string): Promise<void> | void;
}

export interface RuntimeLogger {
  info(message: string): void;
  info(context: Record<string, unknown>, message: string): void;
  warn(message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface ApplicationRuntimeOptions {
  postgres: { query(query: string): Promise<unknown>; end(): Promise<void> };
  redis: { ping(): Promise<string>; quit(): Promise<unknown> };
  monitoring: LifecycleComponent;
  pendingMonitoring: LifecycleComponent;
  confirmation: LifecycleComponent;
  recovery?: LifecycleComponent;
  backgroundWorkers?: LifecycleComponent;
  health?: LifecycleComponent;
  sourceReconciliation?: LifecycleComponent;
  telegram?: TelegramComponent;
  automaticExecutionEnabled: boolean;
  automaticExecutionProvider?: string;
  logger: RuntimeLogger;
}

export class ApplicationRuntime {
  private shuttingDown = false;
  private backgroundWorkerRetryTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: ApplicationRuntimeOptions) {}

  async start(): Promise<void> {
    await this.options.postgres.query('SELECT 1');
    this.options.logger.info('PostgreSQL ready');

    let redisReady = false;
    try {
      await this.options.redis.ping(); redisReady = true;
      this.options.logger.info('Redis ready');
    } catch (error) {
      this.options.logger.warn({ error }, 'Redis unavailable; background execution remains fail-closed');
    }

    let recoveryReady = !this.options.recovery && !this.options.backgroundWorkers;
    try {
      if (redisReady && this.options.backgroundWorkers) { await this.options.backgroundWorkers.start(); recoveryReady = true; this.options.logger.info('Redis background workers ready'); }
      else if (this.options.backgroundWorkers) this.scheduleBackgroundWorkerRetry();
      else if (!this.options.backgroundWorkers) { await this.options.recovery?.start(); if (this.options.recovery) recoveryReady = true; }
      if (this.options.recovery && !this.options.backgroundWorkers) this.options.logger.info('Execution recovery ready');
    } catch (error) {
      this.options.logger.error({ error }, 'Execution recovery unavailable; automatic execution will remain unavailable');
    }

    try {
      await this.options.monitoring.start();
      this.options.logger.info('Blockchain monitoring ready');
    } catch (error) {
      this.options.logger.error({ error }, 'Blockchain monitoring unavailable');
    }

    let pendingReady = false;
    try {
      await this.options.pendingMonitoring.start();
      pendingReady = true;
      this.options.logger.info('Pending monitoring ready');
    } catch (error) {
      this.options.logger.error({ error }, 'Pending monitoring unavailable');
    }
    if (this.options.automaticExecutionEnabled && pendingReady && recoveryReady) this.options.logger.info({ signerProvider: this.options.automaticExecutionProvider ?? 'configured' }, 'Automatic execution ready');
    else if (this.options.automaticExecutionEnabled && !recoveryReady) this.options.logger.warn('Automatic execution unavailable because durable recovery failed');
    else if (this.options.automaticExecutionEnabled) this.options.logger.warn('Automatic execution unavailable because pending monitoring failed');
    else this.options.logger.info('Automatic execution disabled; signer is unconfigured');

    if (!this.options.backgroundWorkers) {
      try {
        await this.options.confirmation.start();
        this.options.logger.info('Transaction confirmation and reconciliation ready');
      } catch (error) {
        this.options.logger.error({ error }, 'Transaction confirmation and reconciliation unavailable');
      }
    }

    try { await this.options.health?.start(); if (this.options.health) this.options.logger.info('Health checks ready'); }
    catch (error) { this.options.logger.error({ error }, 'Health checks unavailable'); }
    try { await this.options.sourceReconciliation?.start(); if (this.options.sourceReconciliation) this.options.logger.info('Source transaction reconciliation ready'); }
    catch (error) { this.options.logger.error({ error }, 'Source transaction reconciliation unavailable'); }

    if (!this.options.telegram) {
      this.options.logger.warn('Telegram unavailable; TELEGRAM_BOT_TOKEN is not configured');
      return;
    }

    try {
      await this.options.telegram.launch();
      this.options.logger.info('Telegram ready');
    } catch (error) {
      this.options.logger.warn({ error }, 'Telegram unavailable; worker remains active');
    }
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.backgroundWorkerRetryTimer) clearTimeout(this.backgroundWorkerRetryTimer);
    this.options.logger.info({ reason }, 'Shutting down application components');

    const producerResults = await Promise.allSettled([
      Promise.resolve().then(() => this.options.health?.stop()),
      Promise.resolve().then(() => this.options.sourceReconciliation?.stop()),
      Promise.resolve().then(() => this.options.telegram?.stop(reason)),
      Promise.resolve().then(() => this.options.pendingMonitoring.stop()),
      Promise.resolve().then(() => this.options.monitoring.stop()),
    ]);
    const workerResults = await Promise.allSettled([
      Promise.resolve().then(() => this.options.backgroundWorkers?.stop()),
      Promise.resolve().then(() => this.options.confirmation.stop()),
      Promise.resolve().then(() => this.options.recovery?.stop()),
    ]);
    const resourceResults = await Promise.allSettled([
      Promise.resolve().then(() => this.options.redis.quit()),
      Promise.resolve().then(() => this.options.postgres.end()),
    ]);
    const results = [...producerResults, ...workerResults, ...resourceResults];
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) this.options.logger.error({ failures: failures.length }, 'Some components failed during shutdown');
    else this.options.logger.info('Application shutdown complete');
  }

  private scheduleBackgroundWorkerRetry(): void {
    if (this.shuttingDown || !this.options.backgroundWorkers || this.backgroundWorkerRetryTimer) return;
    this.backgroundWorkerRetryTimer = setTimeout(() => {
      this.backgroundWorkerRetryTimer = undefined;
      void this.startBackgroundWorkers().catch(() => this.scheduleBackgroundWorkerRetry());
    }, 5_000);
  }

  private async startBackgroundWorkers(): Promise<void> {
    if (this.shuttingDown || !this.options.backgroundWorkers) return;
    try {
      await this.options.redis.ping();
      await this.options.backgroundWorkers.start();
      this.options.logger.info('Redis background workers recovered');
    } catch (error) {
      this.options.logger.warn({ error }, 'Redis background workers remain unavailable');
      throw error;
    }
  }
}
