import type { CopyTransactionProposal, UserExecutionSettings } from '../database/types.js';

export type ExecutionDecision = 'EXECUTE' | 'SKIP' | 'RETRY' | 'EXPIRED';
export interface ExecutionPolicyContext {
  proposal: CopyTransactionProposal; settings: UserExecutionSettings;
  monitoredSourceEnabled: boolean; chainEnabled: boolean; destinationOwned: boolean;
  sourceStatus: string; sourceCurrent: boolean; alreadyExecuted: boolean;
  quantity: bigint; contractAddress: string | null; gasEstimate?: bigint;
}
export interface ExecutionPolicyResult { decision: ExecutionDecision; reason: string; }

export class ExecutionPolicy {
  evaluate(context: ExecutionPolicyContext): ExecutionPolicyResult {
    const { proposal, settings } = context;
    if (proposal.expiresAt && proposal.expiresAt.getTime() <= Date.now()) return { decision: 'EXPIRED', reason: 'Proposal expired' };
    if (settings.executionMode !== 'AUTO') return { decision: 'SKIP', reason: 'AUTO mode is disabled' };
    if (!settings.destinationWallet || settings.destinationWallet.toLowerCase() !== proposal.destinationWallet.toLowerCase()) return { decision: 'SKIP', reason: 'Destination wallet is not configured' };
    if (!context.destinationOwned) return { decision: 'SKIP', reason: 'Destination wallet ownership mismatch' };
    if (!context.monitoredSourceEnabled) return { decision: 'SKIP', reason: 'Monitored source wallet is disabled' };
    if (!context.chainEnabled) return { decision: 'SKIP', reason: 'Chain is disabled' };
    if (settings.allowedChains.length && !settings.allowedChains.includes(proposal.chainId)) return { decision: 'SKIP', reason: 'Chain is not allowed' };
    if (proposal.strategy !== 'PUBLIC_MINT' || proposal.proposalStatus === 'UNSUPPORTED') return { decision: 'SKIP', reason: 'Mint strategy or calldata is unsupported' };
    if (proposal.eligibilityStatus !== 'ELIGIBLE') return { decision: 'SKIP', reason: 'Destination-wallet eligibility is not established' };
    if (proposal.simulationStatus !== 'SUCCESS') return { decision: 'SKIP', reason: 'Simulation has not succeeded' };
    if (context.sourceStatus !== 'PENDING' || !context.sourceCurrent) return { decision: 'SKIP', reason: 'Source transaction is no longer current and pending' };
    if (context.alreadyExecuted) return { decision: 'SKIP', reason: 'Source transaction was already claimed' };
    if (!proposal.targetContract || !proposal.calldata || proposal.nativeValue === null) return { decision: 'SKIP', reason: 'Proposal transaction data is incomplete' };
    if (settings.allowedContracts.length && !settings.allowedContracts.some((address) => address.toLowerCase() === context.contractAddress?.toLowerCase())) return { decision: 'SKIP', reason: 'Contract is not allowed' };
    if (settings.maxQuantity !== null && context.quantity > BigInt(settings.maxQuantity)) return { decision: 'SKIP', reason: 'Mint quantity exceeds the configured limit' };
    if (settings.maxNativeValue !== null && BigInt(proposal.nativeValue) > BigInt(settings.maxNativeValue)) return { decision: 'SKIP', reason: 'Native value exceeds the configured limit' };
    if (context.gasEstimate !== undefined && settings.maxGas !== null && context.gasEstimate > BigInt(settings.maxGas)) return { decision: 'SKIP', reason: 'Gas estimate exceeds the configured limit' };
    return { decision: 'EXECUTE', reason: 'All automatic execution policy checks passed' };
  }
}
