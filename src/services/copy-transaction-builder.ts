import type { CopyTransactionProposal, DetectedMint, EligibilityStatus, ProposalStatus, SimulationStatus } from '../database/types.js';
import type { CopyTransactionProposalRepository } from '../database/repositories/copy-transaction-proposal-repository.js';
import type { TransactionAnalysisProvider } from '../blockchain/clients/transaction-analysis-provider.js';
import type { StrategyAnalysis } from '../blockchain/decoders/mint-calldata-strategies.js';

export class CopyTransactionBuilder {
  constructor(private readonly proposals: CopyTransactionProposalRepository, private readonly onReady?: (proposal: CopyTransactionProposal) => Promise<void>) {}
  async build(mint: DetectedMint, destinationWallet: string, userId: string, source: { to: string | null; value: bigint }, strategy: StrategyAnalysis, provider: TransactionAnalysisProvider): Promise<CopyTransactionProposal> {
    let eligibilityStatus: EligibilityStatus = 'ELIGIBILITY_UNKNOWN';
    let proposalStatus: ProposalStatus = 'UNSUPPORTED';
    let simulationStatus: SimulationStatus = 'NOT_RUN';
    let simulationError: string | null = null;
    let gasLimit: string | null = null;
    let explanation = strategy.explanation;
    const buildable = strategy.strategy === 'PUBLIC_MINT' && strategy.supported && strategy.calldata && source.to;
    if (strategy.strategy === 'MERKLE_ALLOWLIST' || strategy.strategy === 'SIGNATURE_AUTHORIZED') proposalStatus = 'ELIGIBILITY_REQUIRED';
    if (buildable) {
      const request = { from: destinationWallet, to: source.to as string, data: strategy.calldata as `0x${string}`, value: source.value };
      const simulation = await provider.simulate(request);
      if (simulation.success) {
        simulationStatus = 'SUCCESS'; eligibilityStatus = 'ELIGIBLE'; proposalStatus = 'READY';
        try { gasLimit = (await provider.estimateGas(request)).toString(); } catch { explanation += ' Gas estimation was unavailable.'; }
      } else {
        simulationStatus = 'REVERTED'; simulationError = simulation.error; eligibilityStatus = 'NOT_ELIGIBLE'; proposalStatus = 'NOT_ELIGIBLE'; explanation += ' Simulation reverted for the destination wallet.';
      }
    }
    const confidence = strategy.strategy === 'PUBLIC_MINT' && strategy.supported ? 'HIGH' : strategy.strategy === 'UNKNOWN' ? 'LOW' : 'MEDIUM';
    const proposal = await this.proposals.createIfAbsent({ userId, detectedMintId: mint.id, detectedTransactionId: mint.detectedTransactionId, mintQuantity: strategy.quantity?.toString() ?? mint.quantity, sourceTransactionHash: mint.transactionHash, destinationWallet, chainId: mint.chainId, strategy: strategy.strategy, eligibilityStatus, targetContract: buildable ? source.to : null, calldata: buildable ? strategy.calldata : null, nativeValue: buildable ? source.value.toString() : null, gasLimit, simulationStatus, simulationError, proposalStatus, confidence, expiresAt: new Date(Date.now() + 10 * 60_000), explanation });
    if (proposal.executionStatus === 'READY' && this.onReady) await this.onReady(proposal);
    return proposal;
  }
}
