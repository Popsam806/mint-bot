import type { Logger } from 'pino';
import type { EvmChainConfig } from '../config/chains.js';
import type { CopyTransactionProposalRepository } from '../database/repositories/copy-transaction-proposal-repository.js';
import type { UserExecutionSettingsRepository } from '../database/repositories/user-execution-settings-repository.js';
import type { DetectedTransaction, MonitoredAddress } from '../database/types.js';
import type { PendingAnalysisHook } from '../blockchain/listeners/pending-monitoring-engine.js';
import type { ExecutionClient } from '../blockchain/clients/execution-client.js';
import type { TransactionExecutor } from './transaction-executor.js';
import { analyzeMintCalldata } from '../blockchain/decoders/mint-calldata-strategies.js';

export class PendingAutomaticExecutionService implements PendingAnalysisHook {
  constructor(private readonly settings: UserExecutionSettingsRepository, private readonly proposals: CopyTransactionProposalRepository,
    private readonly clients: (chain: EvmChainConfig) => ExecutionClient, private readonly executor: TransactionExecutor, private readonly logger: Logger,
    private readonly onChainResolved?: (databaseChainId: string, externalChainId: number) => void,
    private readonly executionReady: () => boolean = () => true) {}

  async onPending(value: unknown, monitored: MonitoredAddress, chain?: EvmChainConfig): Promise<void> {
    if (!chain) return;
    const transaction = value as DetectedTransaction;
    this.onChainResolved?.(transaction.chainId, chain.id);
    const settings = await this.settings.getOrCreate(monitored.userId);
    if (settings.executionMode !== 'AUTO' || !settings.destinationWallet) return;
    if (!this.executionReady()) { this.logger.warn({ transactionHash: transaction.transactionHash }, 'Automatic execution is blocked pending durable recovery'); return; }
    const strategy = analyzeMintCalldata(transaction.inputData as `0x${string}`, monitored.walletAddress, settings.destinationWallet);
    if (strategy.strategy !== 'PUBLIC_MINT' || !strategy.supported || !strategy.calldata || !transaction.toAddress || strategy.quantity === null) {
      this.logger.info({ transactionHash: transaction.transactionHash, strategy: strategy.strategy }, 'Pending transaction is not eligible for automatic execution');
      return;
    }
    const client = this.clients(chain);
    const request = { from: settings.destinationWallet, to: transaction.toAddress, data: strategy.calldata, value: BigInt(transaction.transactionValue) };
    const simulation = await client.simulate(request);
    if (!simulation.success) { this.logger.info({ transactionHash: transaction.transactionHash }, 'Pending copy simulation failed'); return; }
    const gas = await client.estimateGas(request);
    const proposal = await this.proposals.createIfAbsent({ userId: monitored.userId, detectedMintId: null, detectedTransactionId: transaction.id,
      mintQuantity: strategy.quantity.toString(), sourceTransactionHash: transaction.transactionHash, destinationWallet: settings.destinationWallet,
      chainId: transaction.chainId, strategy: strategy.strategy, eligibilityStatus: 'ELIGIBLE', targetContract: transaction.toAddress,
      calldata: strategy.calldata, nativeValue: transaction.transactionValue, gasLimit: gas.toString(), simulationStatus: 'SUCCESS',
      simulationError: null, proposalStatus: 'READY', confidence: 'HIGH', expiresAt: new Date(Date.now() + settings.proposalExpirationSeconds * 1000), explanation: strategy.explanation });
    try { await this.executor.execute(proposal); }
    catch (error) { this.logger.warn({ transactionHash: transaction.transactionHash, error }, 'Automatic pending execution did not submit'); }
  }
}
