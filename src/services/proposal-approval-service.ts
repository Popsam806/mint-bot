import type { CopyTransactionProposal, ExecutionRequest } from '../database/types.js';
import type { CopyTransactionProposalRepository } from '../database/repositories/copy-transaction-proposal-repository.js';
import type { ExecutionRequestRepository } from '../database/repositories/execution-request-repository.js';
import type { MonitoredAddressRepository } from '../database/repositories/monitored-address-repository.js';
import type { UserRepository } from '../database/repositories/user-repository.js';

export class ProposalNotFoundError extends Error {}
export class ProposalUnauthorizedError extends Error {}
export class ProposalExpiredError extends Error {}
export class ProposalAlreadyProcessedError extends Error {}
export class ProposalNotReadyError extends Error {}

export class ProposalApprovalService {
  constructor(private readonly proposals: CopyTransactionProposalRepository, private readonly requests: ExecutionRequestRepository, private readonly users: UserRepository, private readonly addresses: MonitoredAddressRepository) {}

  async approve(telegramUserId: string, proposalId: string, now = new Date()): Promise<ExecutionRequest> {
    const { proposal, userId } = await this.authorize(telegramUserId, proposalId);
    if (proposal.expiresAt && proposal.expiresAt <= now) {
      if (proposal.executionStatus === 'READY') await this.proposals.changeExecutionStatus(proposal.id, 'READY', 'EXPIRED');
      throw new ProposalExpiredError();
    }
    if (proposal.executionStatus !== 'READY') throw new ProposalAlreadyProcessedError();
    if (proposal.proposalStatus !== 'READY' || proposal.simulationStatus !== 'SUCCESS') throw new ProposalNotReadyError();
    const approved = await this.proposals.changeExecutionStatus(proposal.id, 'READY', 'APPROVED');
    if (!approved) throw new ProposalAlreadyProcessedError();
    return this.requests.createIfAbsent(proposal.id, userId);
  }

  async reject(telegramUserId: string, proposalId: string): Promise<CopyTransactionProposal> {
    const { proposal } = await this.authorize(telegramUserId, proposalId);
    if (proposal.executionStatus !== 'READY') throw new ProposalAlreadyProcessedError();
    const rejected = await this.proposals.changeExecutionStatus(proposal.id, 'READY', 'REJECTED');
    if (!rejected) throw new ProposalAlreadyProcessedError();
    return rejected;
  }

  private async authorize(telegramUserId: string, proposalId: string): Promise<{ proposal: CopyTransactionProposal; userId: string }> {
    const proposal = await this.proposals.findById(proposalId);
    if (!proposal) throw new ProposalNotFoundError();
    const user = await this.users.findByTelegramUserId(telegramUserId);
    if (!user || proposal.userId !== user.id) throw new ProposalUnauthorizedError();
    if (!await this.addresses.findByUserAndWallet(user.id, proposal.destinationWallet)) throw new ProposalUnauthorizedError();
    return { proposal, userId: user.id };
  }
}
