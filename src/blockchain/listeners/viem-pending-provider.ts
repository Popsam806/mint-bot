import type { PublicClient } from 'viem';
import type { PendingCapability, PendingObservation, PendingSourceTransaction, PendingTransactionProvider } from './pending-transaction-provider.js';

export class ViemPendingTransactionProvider implements PendingTransactionProvider {
  private pendingFilterId?: `0x${string}`;

  constructor(private readonly client: PublicClient, private readonly websocketClient: PublicClient | undefined, private readonly configuredMode: PendingCapability, private readonly providerName = 'viem-rpc') {}
  async detectCapability(): Promise<PendingCapability> {
    if (this.configuredMode === 'websocket' && !this.websocketClient) return 'unsupported';
    return this.configuredMode;
  }
  async subscribe(onObservation: (observation: PendingObservation) => void, onError: (error: unknown) => void): Promise<() => void> {
    if (await this.detectCapability() !== 'websocket' || !this.websocketClient) throw new Error('Pending WebSocket subscription is unsupported');
    return this.websocketClient.watchPendingTransactions({ onTransactions: (hashes) => { const observedAt = new Date(); for (const hash of hashes) onObservation({ hash, observedAt, provider: this.providerName }); }, onError });
  }
  async poll(): Promise<PendingObservation[]> {
    const capability = await this.detectCapability();
    if (capability === 'unsupported') return [];

    let hashes: string[];
    if (capability === 'filter' || capability === 'websocket') {
      try {
        this.pendingFilterId ??= await this.client.request({
          method: 'eth_newPendingTransactionFilter' as never,
          params: [] as never,
        }) as `0x${string}`;
        hashes = await this.client.request({
          method: 'eth_getFilterChanges' as never,
          params: [this.pendingFilterId] as never,
        }) as unknown as string[];
      } catch (error) {
        if (capability === 'filter') throw error;
        hashes = await this.pollPendingTransactions();
      }
    } else {
      hashes = await this.pollPendingTransactions();
    }
    const observedAt = new Date();
    return hashes.map((hash) => ({ hash, observedAt, provider: this.providerName }));
  }

  private async pollPendingTransactions(): Promise<string[]> {
    return this.client.request({
      method: 'eth_pendingTransactions' as never,
      params: [] as never,
    }) as unknown as string[];
  }
  async getTransaction(hash: string): Promise<PendingSourceTransaction | null> {
    try {
      const transaction = await this.client.getTransaction({ hash: hash as `0x${string}` });
      if (transaction.blockNumber !== null) return null;
      return { hash: transaction.hash, from: transaction.from, to: transaction.to, nonce: BigInt(transaction.nonce), value: transaction.value, input: transaction.input, gas: transaction.gas, gasPrice: transaction.gasPrice ?? null, maxFeePerGas: transaction.maxFeePerGas ?? null, maxPriorityFeePerGas: transaction.maxPriorityFeePerGas ?? null };
    } catch { return null; }
  }
}
