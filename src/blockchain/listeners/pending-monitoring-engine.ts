import type { Logger } from 'pino';
import type { EvmChainManager } from '../clients/evm-chain-manager.js';
import type { MonitoredAddress } from '../../database/types.js';
import type { DetectedTransactionRepository } from '../../database/repositories/detected-transaction-repository.js';
import type { PendingTransactionProvider, PendingObservation } from './pending-transaction-provider.js';
import type { EvmChainConfig } from '../../config/chains.js';
import { ViemPendingTransactionProvider } from './viem-pending-provider.js';

export interface PendingAnalysisHook { onPending(transaction: unknown, monitored: MonitoredAddress, chain?: EvmChainConfig): Promise<void>; }
export interface PendingMonitoringOptions { pollingIntervalMs?: number; dropTimeoutMs?: number; refreshIntervalMs?: number; }

class ChainPendingMonitor {
  private stopSubscription?: () => void;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private dropTimer?: ReturnType<typeof setTimeout>;
  private readonly seen = new Set<string>();
  private readonly active = new Map<string, Date>();
  private running = false;
  constructor(private readonly config: EvmChainConfig, private readonly databaseChainId: string, private readonly provider: PendingTransactionProvider, private readonly addresses: () => readonly MonitoredAddress[], private readonly repository: DetectedTransactionRepository, private readonly hook: PendingAnalysisHook | undefined, private readonly logger: Logger, private readonly options: PendingMonitoringOptions) {}

  async start(): Promise<void> {
    this.running = true;
    const capability = await this.provider.detectCapability();
    this.logger.info({ chainId: this.config.id, pendingCapability: capability }, 'Pending chain monitor starting');
    if (capability === 'websocket') {
      try { this.stopSubscription = await this.provider.subscribe((observation) => void this.handle(observation), (error) => this.handleDisconnect(error)); }
      catch (error) { this.logger.warn({ chainId: this.config.id, error }, 'Pending subscription unavailable; falling back'); this.startPolling(); }
    } else if (capability === 'filter' || capability === 'polling') this.startPolling();
    else this.logger.warn({ chainId: this.config.id }, 'Pending transaction monitoring unsupported by provider');
    this.startDropReconciliation();
  }
  async stop(): Promise<void> { this.running = false; this.stopSubscription?.(); if (this.pollTimer) clearTimeout(this.pollTimer); if (this.dropTimer) clearTimeout(this.dropTimer); }
  private handleDisconnect(error: unknown): void { if (!this.running) return; this.logger.warn({ chainId: this.config.id, error }, 'Pending subscription disconnected'); this.stopSubscription?.(); this.startPolling(); }
  private startPolling(): void {
    if (this.pollTimer || !this.running) return;
    const poll = async () => { if (!this.running) return; try { for (const observation of await this.provider.poll()) await this.handle(observation); } catch (error) { this.logger.warn({ chainId: this.config.id, error }, 'Pending polling failed'); } finally { if (this.running) this.pollTimer = setTimeout(poll, this.options.pollingIntervalMs ?? 500); else this.pollTimer = undefined; } };
    this.pollTimer = setTimeout(poll, 0);
  }
  private startDropReconciliation(): void {
    const run = async () => { if (!this.running) return; const cutoff = new Date(Date.now() - (this.options.dropTimeoutMs ?? 120_000)); await this.repository.markDroppedBefore(cutoff).catch((error) => this.logger.warn({ chainId: this.config.id, error }, 'Pending drop reconciliation failed')); if (this.running) this.dropTimer = setTimeout(run, this.options.dropTimeoutMs ?? 120_000); };
    this.dropTimer = setTimeout(run, this.options.dropTimeoutMs ?? 120_000);
  }
  private async handle(observation: PendingObservation): Promise<void> {
    const hash = observation.hash.toLowerCase();
    if (this.seen.has(hash)) { this.active.set(hash, observation.observedAt); return; }
    this.seen.add(hash);
    const transaction = await this.provider.getTransaction(observation.hash);
    if (!transaction) return;
    const monitored = this.addresses().find((address) => address.enabled && address.walletAddress.toLowerCase() === transaction.from.toLowerCase());
    if (!monitored) return;
    this.active.set(hash, observation.observedAt);
    const saved = await this.repository.upsertPending({ monitoredAddressId: monitored.id, chainId: this.databaseChainId, transaction, observation });
    this.logger.info({ chainId: this.config.id, transactionHash: saved.transactionHash, observedAt: observation.observedAt.toISOString(), ingestedAt: saved.ingestedAt.toISOString() }, 'Pending monitored transaction detected');
    if (this.hook) await this.hook.onPending(saved, monitored, this.config);
  }
}

export class PendingMonitoringEngine {
  private readonly monitors = new Map<number, ChainPendingMonitor>();
  private readonly addresses = new Map<number, Array<MonitoredAddress & { externalChainId: string }>>();
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private running = false;
  constructor(private readonly chainManager: EvmChainManager, private readonly monitoredAddresses: { listEnabledByChain(): Promise<Array<MonitoredAddress & { externalChainId: string }>> }, private readonly repository: DetectedTransactionRepository, private readonly logger: Logger, private readonly providerFactory: (config: EvmChainConfig) => PendingTransactionProvider = (config) => new ViemPendingTransactionProvider(this.chainManager.getPublicClient(config.id), config.websocketRpcUrl ? this.chainManager.getWebSocketClient(config.id) : undefined, config.pendingTransactionMode), private readonly hook?: PendingAnalysisHook, private readonly options: PendingMonitoringOptions = {}) {}
  async start(): Promise<void> { this.running = true; await this.refresh(); }
  async stop(): Promise<void> { this.running = false; if (this.refreshTimer) clearTimeout(this.refreshTimer); await Promise.all([...this.monitors.values()].map((monitor) => monitor.stop())); this.monitors.clear(); }
  async refreshNow(): Promise<void> { await this.refresh(false); }
  private async refresh(scheduleNext = true): Promise<void> {
    if (!this.running) return;
    const enabled = await this.monitoredAddresses.listEnabledByChain();
    this.addresses.clear();
    for (const address of enabled) { const id = Number(address.externalChainId); this.addresses.set(id, [...(this.addresses.get(id) ?? []), address]); }
    for (const config of this.chainManager.getConfiguredChains()) {
      const addresses = this.addresses.get(config.id) ?? [];
      if (!addresses.length || this.monitors.has(config.id)) continue;
      const monitor = new ChainPendingMonitor(config, addresses[0]!.chainId, this.providerFactory(config), () => this.addresses.get(config.id) ?? [], this.repository, this.hook, this.logger, this.options);
      this.monitors.set(config.id, monitor); await monitor.start();
    }
    if (this.running && scheduleNext) this.refreshTimer = setTimeout(() => void this.refresh(), this.options.refreshIntervalMs ?? 30_000);
  }
}
