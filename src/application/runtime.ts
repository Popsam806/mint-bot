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
  telegram?: TelegramComponent;
  automaticExecutionEnabled: boolean;
  automaticExecutionProvider?: string;
  logger: RuntimeLogger;
}

export class ApplicationRuntime {
  private shuttingDown = false;

  constructor(private readonly options: ApplicationRuntimeOptions) {}

  async start(): Promise<void> {
    await this.options.postgres.query('SELECT 1');
    this.options.logger.info('PostgreSQL ready');

    try {
      await this.options.redis.ping();
      this.options.logger.info('Redis ready');
    } catch (error) {
      this.options.logger.warn({ error }, 'Redis unavailable; no Redis-backed worker is currently enabled');
    }

    let recoveryReady = !this.options.recovery;
    try {
      await this.options.recovery?.start();
      if (this.options.recovery) { recoveryReady = true; this.options.logger.info('Execution recovery ready'); }
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

    try {
      await this.options.confirmation.start();
      this.options.logger.info('Transaction confirmation and reconciliation ready');
    } catch (error) {
      this.options.logger.error({ error }, 'Transaction confirmation and reconciliation unavailable');
    }

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
    this.options.logger.info({ reason }, 'Shutting down application components');

    const results = await Promise.allSettled([
      Promise.resolve().then(() => this.options.telegram?.stop(reason)),
      Promise.resolve().then(() => this.options.confirmation.stop()),
      Promise.resolve().then(() => this.options.recovery?.stop()),
      Promise.resolve().then(() => this.options.pendingMonitoring.stop()),
      Promise.resolve().then(() => this.options.monitoring.stop()),
      Promise.resolve().then(() => this.options.redis.quit()),
      Promise.resolve().then(() => this.options.postgres.end()),
    ]);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) this.options.logger.error({ failures: failures.length }, 'Some components failed during shutdown');
    else this.options.logger.info('Application shutdown complete');
  }
}
