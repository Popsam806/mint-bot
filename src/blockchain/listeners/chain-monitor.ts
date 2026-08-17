import type { Logger } from 'pino';
import type { DetectedTransaction, MonitoredAddress } from '../../database/types.js';
import type { DetectedTransactionRepository } from '../../database/repositories/detected-transaction-repository.js';
import type { MonitoringCheckpointRepository } from '../../database/repositories/monitoring-checkpoint-repository.js';
import type { ChainBlockProvider, MinedBlock } from './types.js';

export interface ChainMonitorOptions {
  databaseChainId: string; externalChainId: number; chainName: string; provider: ChainBlockProvider;
  hasWebSocket: boolean; getAddresses: () => readonly MonitoredAddress[];
  transactions: DetectedTransactionRepository; checkpoints: MonitoringCheckpointRepository; logger: Logger;
  confirmations?: bigint; pollingIntervalMs?: number; reconnectDelayMs?: number;
  onTransactionDetected?: (transaction: DetectedTransaction, monitored: MonitoredAddress) => Promise<void>;
}

export class ChainMonitor {
  private running = false;
  private unwatch?: () => void;
  private pollingTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private processing = Promise.resolve();
  constructor(private readonly options: ChainMonitorOptions) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.options.logger.info({ chainId: this.options.externalChainId, chain: this.options.chainName }, 'Chain monitor starting');
    await this.processAvailable();
    if (this.options.hasWebSocket) this.startWebSocket(); else this.startPolling();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.unwatch?.();
    if (this.pollingTimer) clearTimeout(this.pollingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.processing;
  }

  private startWebSocket(): void {
    if (!this.running) return;
    try {
      this.unwatch = this.options.provider.watchBlockNumbers((block) => {
        this.options.logger.debug({ chainId: this.options.externalChainId, block: block.toString() }, 'New block');
        this.queueProcessing();
      }, (error) => this.handleWebSocketFailure(error));
    } catch (error) { this.handleWebSocketFailure(error); }
  }

  private handleWebSocketFailure(error: unknown): void {
    if (!this.running) return;
    this.unwatch?.(); this.unwatch = undefined;
    this.options.logger.warn({ chainId: this.options.externalChainId, error }, 'WebSocket disconnected; using polling fallback');
    this.startPolling();
    this.reconnectTimer = setTimeout(() => {
      if (!this.running) return;
      this.options.logger.info({ chainId: this.options.externalChainId }, 'Attempting WebSocket reconnect');
      this.startWebSocket();
    }, this.options.reconnectDelayMs ?? 30_000);
  }

  private startPolling(): void {
    if (!this.running || this.pollingTimer) return;
    this.options.logger.info({ chainId: this.options.externalChainId }, 'Polling fallback active');
    const poll = async () => {
      if (!this.running) return;
      await this.queueProcessing();
      if (this.running) this.pollingTimer = setTimeout(poll, this.options.pollingIntervalMs ?? 5_000);
    };
    this.pollingTimer = setTimeout(poll, 0);
  }

  private queueProcessing(): Promise<void> {
    this.processing = this.processing.then(() => this.processAvailable()).catch((error) => {
      this.options.logger.error({ chainId: this.options.externalChainId, error }, 'Chain block processing failed');
    });
    return this.processing;
  }

  private async processAvailable(): Promise<void> {
    const head = await this.options.provider.getBlockNumber();
    const confirmations = this.options.confirmations ?? 2n;
    if (head < confirmations) return;
    const safeHead = head - confirmations;
    let checkpoint = await this.options.checkpoints.get(this.options.databaseChainId);
    if (checkpoint === null) checkpoint = safeHead > 0n ? safeHead - 1n : 0n;
    for (let number = checkpoint + 1n; this.running && number <= safeHead; number += 1n) {
      const block = await this.options.provider.getBlock(number);
      await this.processBlock(block);
      await this.options.checkpoints.save(this.options.databaseChainId, number);
    }
  }

  private async processBlock(block: MinedBlock): Promise<void> {
    const byAddress = new Map(this.options.getAddresses().filter((item) => item.enabled).map((item) => [item.walletAddress.toLowerCase(), item]));
    for (const transaction of block.transactions) {
      if (typeof this.options.transactions.markMined === 'function') await this.options.transactions.markMined(transaction.hash, block.number);
      const monitored = byAddress.get(transaction.from.toLowerCase());
      if (!monitored) continue;
      const saved = await this.options.transactions.createIfAbsent({
        monitoredAddressId: monitored.id, chainId: this.options.databaseChainId, transactionHash: transaction.hash,
        blockNumber: block.number.toString(), fromAddress: transaction.from, toAddress: transaction.to,
        transactionValue: transaction.value.toString(), inputData: transaction.input, gasLimit: transaction.gas?.toString() ?? null,
        gasPrice: transaction.gasPrice?.toString() ?? null, effectiveGasPrice: transaction.effectiveGasPrice?.toString() ?? null,
      });
      if (saved) {
        this.options.logger.info({ chainId: this.options.externalChainId, transactionHash: saved.transactionHash, monitoredAddress: monitored.walletAddress }, 'Detected monitored transaction');
        if (this.options.onTransactionDetected) {
          try { await this.options.onTransactionDetected(saved, monitored); }
          catch (error) { this.options.logger.error({ transactionHash: saved.transactionHash, error }, 'Transaction classification failed'); }
        }
      }
    }
  }
}
