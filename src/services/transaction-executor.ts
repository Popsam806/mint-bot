import { keccak256 } from 'viem';
import type { CopyTransactionProposal, UserExecutionSettings } from '../database/types.js';
import type { ExecutionAttemptRepository } from '../database/repositories/execution-attempt-repository.js';
import type { AutomaticExecutionContext, AutomaticExecutionContextRepository } from '../database/repositories/automatic-execution-context-repository.js';
import type { CopyTransactionProposalRepository } from '../database/repositories/copy-transaction-proposal-repository.js';
import type { UserExecutionSettingsRepository } from '../database/repositories/user-execution-settings-repository.js';
import type { ExecutionClient } from '../blockchain/clients/execution-client.js';
import type { Signer, UnsignedTransaction } from './signer.js';
import { DestinationNonceManager } from './destination-nonce-manager.js';
import { ExecutionPolicy } from './execution-policy.js';
import { LocalDestinationWalletLock, type DestinationWalletLock } from './destination-wallet-lock.js';

export interface ExecutionResult { transactionHash: string; submittedAt: Date; attemptId?: string; }
export interface TransactionExecutor { execute(proposal: CopyTransactionProposal): Promise<ExecutionResult>; }
export interface ChainExecutionClient { chainId: number; client: ExecutionClient; }
class ExecutionPolicyError extends Error {}

export class AutomaticTransactionExecutor implements TransactionExecutor {
  constructor(
    private readonly proposals: CopyTransactionProposalRepository,
    private readonly settings: UserExecutionSettingsRepository,
    private readonly contexts: AutomaticExecutionContextRepository,
    private readonly attempts: ExecutionAttemptRepository,
    private readonly signer: Signer,
    private readonly clients: (databaseChainId: string) => ChainExecutionClient,
    private readonly policy = new ExecutionPolicy(),
    private readonly nonces = new DestinationNonceManager(),
    private readonly walletLock: DestinationWalletLock = new LocalDestinationWalletLock(),
  ) {}

  async execute(input: CopyTransactionProposal): Promise<ExecutionResult> {
    const proposal = await this.proposals.findById(input.id);
    if (!proposal || !proposal.userId) throw new Error('Execution proposal is unavailable or has no owner');
    const [settings, context] = await Promise.all([this.settings.getOrCreate(proposal.userId), this.contexts.load(proposal.id)]);
    if (!context) throw new Error('Execution context is unavailable');
    this.requirePolicy(proposal, settings, context, false, proposal.gasLimit === null ? undefined : BigInt(proposal.gasLimit));

    const attempt = await this.attempts.claim({ proposalId: proposal.id, sourceTransactionHash: proposal.sourceTransactionHash,
      destinationWallet: proposal.destinationWallet, chainId: proposal.chainId, pendingDetectedAt: context.pendingDetectedAt,
      analysisStartedAt: context.analysisStartedAt, analysisCompletedAt: context.analysisCompletedAt, allowRetry: settings.autoRetryEnabled });
    if (!attempt) throw new Error('Execution opportunity was already claimed');

    const { chainId, client } = this.clients(proposal.chainId);
    return this.nonces.serialize(chainId, proposal.destinationWallet, () => this.walletLock.withLock(chainId, proposal.destinationWallet, async () => {
      let signed = false;
      try {
        await this.attempts.transition(attempt.id, 'SIMULATING');
        const request = { from: proposal.destinationWallet, to: proposal.targetContract!, data: proposal.calldata! as `0x${string}`, value: BigInt(proposal.nativeValue!) };
        const simulation = await client.simulate(request);
        if (!simulation.success) {
          await this.attempts.transition(attempt.id, 'SKIPPED', { failureReason: `Fresh simulation failed: ${simulation.error}` });
          throw new Error('Fresh simulation failed; transaction was not signed');
        }
        const gas = await client.estimateGas(request);
        const refreshedContext = await this.contexts.load(proposal.id);
        if (!refreshedContext) throw new Error('Execution context disappeared');
        this.requirePolicy(proposal, settings, refreshedContext, false, gas);

        const signerAddress = (await this.signer.getAddress()).toLowerCase();
        if (signerAddress !== proposal.destinationWallet.toLowerCase()) {
          await this.attempts.transition(attempt.id, 'FAILED', { failureReason: 'Signer address does not match destination wallet' });
          throw new Error('Signer address does not match destination wallet');
        }

        const [nonce, fees] = await Promise.all([client.getPendingNonce(proposal.destinationWallet), client.estimateFees()]);
        const transaction: UnsignedTransaction = { chainId, to: proposal.targetContract! as `0x${string}`, data: proposal.calldata! as `0x${string}`,
          value: BigInt(proposal.nativeValue!), gas, nonce, ...fees };
        await this.attempts.transition(attempt.id, 'SIGNING', { unsignedTransaction: this.metadata(transaction), nonce: BigInt(nonce), gasEstimate: gas, nativeValue: transaction.value });
        const serialized = await this.signer.signTransaction(transaction);
        signed = true;
        await this.attempts.transition(attempt.id, 'SIGNED');
        let transactionHash: string;
        try {
          transactionHash = await client.broadcast(serialized);
        } catch (error) {
          if (!this.isAlreadyKnown(error)) throw error;
          transactionHash = keccak256(serialized as `0x${string}`);
        }
        await this.attempts.transition(attempt.id, 'SUBMITTED', { copyTransactionHash: transactionHash });
        await this.proposals.changeExecutionStatus(proposal.id, proposal.executionStatus, 'SUBMITTED');
        return { transactionHash, submittedAt: new Date(), attemptId: attempt.id };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Automatic execution failed';
        if (error instanceof ExecutionPolicyError) await this.attempts.transition(attempt.id, 'SKIPPED', { failureReason: message });
        else if (!signed && settings.autoRetryEnabled && !message.includes('not signed') && !message.includes('Signer address')) {
          await this.attempts.transition(attempt.id, 'RETRY', { failureReason: message, retry: true });
        } else if (!message.includes('not signed') && !message.includes('already claimed') && !message.includes('Signer address')) {
          await this.attempts.transition(attempt.id, 'FAILED', { failureReason: message });
        }
        throw error;
      }
    }));
  }

  private requirePolicy(proposal: CopyTransactionProposal, settings: UserExecutionSettings, context: AutomaticExecutionContext, alreadyExecuted: boolean, gasEstimate?: bigint): void {
    const result = this.policy.evaluate({ proposal, settings, monitoredSourceEnabled: context.monitoredSourceEnabled,
      chainEnabled: context.chainEnabled, destinationOwned: proposal.userId === settings.userId && settings.destinationWallet?.toLowerCase() === proposal.destinationWallet.toLowerCase(),
      sourceStatus: context.sourceStatus, sourceCurrent: context.sourceCurrent, alreadyExecuted, quantity: context.quantity,
      contractAddress: context.contractAddress, gasEstimate });
    if (result.decision !== 'EXECUTE') throw new ExecutionPolicyError(`${result.decision}: ${result.reason}`);
  }
  private metadata(transaction: UnsignedTransaction): Record<string, string> {
    const metadata = { chainId: String(transaction.chainId), to: transaction.to, data: transaction.data, value: transaction.value.toString(), gas: transaction.gas.toString(), nonce: String(transaction.nonce) };
    return transaction.gasPrice !== undefined ? { ...metadata, gasPrice: transaction.gasPrice.toString() } : { ...metadata, maxFeePerGas: transaction.maxFeePerGas!.toString(), maxPriorityFeePerGas: transaction.maxPriorityFeePerGas!.toString() };
  }
  private isAlreadyKnown(error: unknown): boolean { return error instanceof Error && /already known|known transaction/i.test(error.message); }
}

export class UnconfiguredTransactionExecutor implements TransactionExecutor {
  async execute(proposal: CopyTransactionProposal): Promise<ExecutionResult> {
    void proposal;
    throw new Error('Transaction execution is not configured. No transaction was signed or broadcast.');
  }
}
