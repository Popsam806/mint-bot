import { createServer, type Server } from 'node:http';
import type { Logger } from 'pino';

export interface ReadinessDependency { name: string; check(): Promise<void>; }

export class OperationalHealthService {
  private server?: Server;
  private readonly startedAt = Date.now();
  constructor(private readonly port: number, private readonly dependencies: ReadinessDependency[], private readonly logger: Logger) {}
  async start(): Promise<void> {
    if (this.server || this.port === 0) return;
    this.server = createServer((request, response) => void this.handle(request.url ?? '/', response));
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(this.port, resolve); });
    this.logger.info({ port: this.port }, 'Operational health endpoint ready');
  }
  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server; this.server = undefined;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  async readiness(): Promise<{ ready: boolean; checks: Record<string, string> }> {
    const checks: Record<string, string> = {}; let ready = true;
    await Promise.all(this.dependencies.map(async (dependency) => {
      try { await dependency.check(); checks[dependency.name] = 'ready'; }
      catch { checks[dependency.name] = 'unavailable'; ready = false; }
    }));
    return { ready, checks };
  }
  private async handle(path: string, response: import('node:http').ServerResponse): Promise<void> {
    if (path === '/health/live') return this.json(response, 200, { live: true, uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1_000) });
    if (path === '/health/ready') { const status = await this.readiness(); return this.json(response, status.ready ? 200 : 503, status); }
    this.json(response, 404, { error: 'not_found' });
  }
  private json(response: import('node:http').ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
  }
}
