import type { Logger } from 'pino';
import type { EvmChainManager } from '../clients/evm-chain-manager.js';
import type { MonitoredAddressRepository } from '../../database/repositories/monitored-address-repository.js';
import type { DetectedTransactionRepository } from '../../database/repositories/detected-transaction-repository.js';
import type { MonitoringCheckpointRepository } from '../../database/repositories/monitoring-checkpoint-repository.js';
import type { MonitoredAddress } from '../../database/types.js';
import { ViemBlockProvider } from './viem-block-provider.js';
import { ChainMonitor } from './chain-monitor.js';
import type { NftMintDetector } from '../../services/nft-mint-detector.js';
import { ViemReceiptProvider } from '../decoders/receipt-provider.js';

export class MonitoringEngine {
  private readonly monitors = new Map<number, ChainMonitor>();
  private readonly addresses = new Map<number, MonitoredAddress[]>();
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private running = false;
  constructor(private readonly chainManager: EvmChainManager, private readonly monitoredAddresses: MonitoredAddressRepository, private readonly transactions: DetectedTransactionRepository, private readonly checkpoints: MonitoringCheckpointRepository, private readonly logger: Logger, private readonly mintDetector?: NftMintDetector) {}

  async start(): Promise<void> {
    this.running = true;
    this.logger.info('Blockchain monitoring engine starting');
    await this.refresh();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    await Promise.allSettled([...this.monitors.values()].map((monitor) => monitor.stop()));
    this.monitors.clear();
  }

  async refreshNow(): Promise<void> {
    await this.refresh(false);
  }

  private async refresh(scheduleNext = true): Promise<void> {
    if (!this.running) return;
    try {
      const active = await this.monitoredAddresses.listEnabledByChain();
      this.addresses.clear();
      for (const address of active) {
        const externalId = Number(address.externalChainId);
        this.addresses.set(externalId, [...(this.addresses.get(externalId) ?? []), address]);
      }
      for (const [chainId, monitor] of this.monitors) {
        if ((this.addresses.get(chainId) ?? []).length) continue;
        await monitor.stop();
        this.monitors.delete(chainId);
        this.logger.info({ chainId }, 'Chain monitor stopped because no enabled wallets remain');
      }
      for (const config of this.chainManager.getConfiguredChains()) {
        const chainAddresses = this.addresses.get(config.id) ?? [];
        if (!chainAddresses.length || this.monitors.has(config.id)) continue;
        const dbChainId = chainAddresses[0]?.chainId;
        if (!dbChainId) continue;
        for (const address of chainAddresses) this.logger.info({ chainId: config.id, monitoredAddress: address.walletAddress }, 'Monitored wallet active');
        const publicClient = this.chainManager.getPublicClient(config.id);
        const provider = new ViemBlockProvider(publicClient, config.websocketRpcUrl ? this.chainManager.getWebSocketClient(config.id) : undefined);
        const receiptProvider = new ViemReceiptProvider(publicClient);
        const monitor = new ChainMonitor({ databaseChainId: dbChainId, externalChainId: config.id, chainName: config.name, provider, hasWebSocket: Boolean(config.websocketRpcUrl), getAddresses: () => this.addresses.get(config.id) ?? [], transactions: this.transactions, checkpoints: this.checkpoints, logger: this.logger, onTransactionDetected: this.mintDetector ? (transaction, monitored) => this.mintDetector!.analyze(transaction, monitored, receiptProvider).then(() => undefined) : undefined });
        this.monitors.set(config.id, monitor);
        void monitor.start().catch((error) => this.logger.error({ chainId: config.id, error }, 'Unable to start chain monitor'));
      }
    } catch (error) { this.logger.error({ error }, 'Unable to refresh monitored addresses'); }
    if (this.running && scheduleNext) this.refreshTimer = setTimeout(() => void this.refresh(), 30_000);
  }
}
