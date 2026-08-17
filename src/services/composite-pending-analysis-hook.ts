import type { MonitoredAddress } from '../database/types.js';
import type { EvmChainConfig } from '../config/chains.js';
import type { PendingAnalysisHook } from '../blockchain/listeners/pending-monitoring-engine.js';

export class CompositePendingAnalysisHook implements PendingAnalysisHook {
  constructor(private readonly hooks: PendingAnalysisHook[]) {}
  async onPending(transaction: unknown, monitored: MonitoredAddress, chain?: EvmChainConfig): Promise<void> {
    for (const hook of this.hooks) await hook.onPending(transaction, monitored, chain);
  }
}
