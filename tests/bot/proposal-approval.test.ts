import { describe, expect, it, vi } from 'vitest';
import { ProposalApprovalService, ProposalAlreadyProcessedError, ProposalExpiredError, ProposalUnauthorizedError } from '../../src/services/proposal-approval-service.js';
import { UnconfiguredTransactionExecutor } from '../../src/services/transaction-executor.js';
import { ProposalNotifier } from '../../src/bot/proposal-notifier.js';
import type { CopyTransactionProposal } from '../../src/database/types.js';

const wallet = '0x0000000000000000000000000000000000000022';
const base = (): CopyTransactionProposal => ({ id: '7', userId: '42', detectedMintId: '1', sourceTransactionHash: '0x' + 'a'.repeat(64), destinationWallet: wallet, chainId: '1', strategy: 'PUBLIC_MINT', eligibilityStatus: 'ELIGIBLE', targetContract: '0x0000000000000000000000000000000000000033', calldata: '0x1234', nativeValue: '1', gasLimit: '100000', simulationStatus: 'SUCCESS', simulationError: null, proposalStatus: 'READY', confidence: 'HIGH', executionStatus: 'READY', expiresAt: new Date(Date.now() + 60_000), explanation: 'ready', createdAt: new Date(), updatedAt: new Date() });

function setup(initial = base()) {
  const proposal = { ...initial };
  const proposals = { findById: vi.fn(async () => proposal), changeExecutionStatus: vi.fn(async (_id: string, expected: string, next: CopyTransactionProposal['executionStatus']) => { if (proposal.executionStatus !== expected) return null; proposal.executionStatus = next; return proposal; }) };
  const requests = { createIfAbsent: vi.fn(async (proposalId: string, userId: string) => ({ id: '99', proposalId, userId, status: 'APPROVED' as const, createdAt: new Date(), updatedAt: new Date() })) };
  const users = { findByTelegramUserId: vi.fn(async (telegramId: string) => telegramId === 'telegram-42' ? { id: '42' } : telegramId === 'telegram-9' ? { id: '9' } : null) };
  const addresses = { findByUserAndWallet: vi.fn(async (userId: string, address: string) => userId === '42' && address === wallet ? { id: 'address-1' } : null) };
  return { service: new ProposalApprovalService(proposals as never, requests as never, users as never, addresses as never), proposal, proposals, requests };
}

describe('Phase 7A proposal approval', () => {
  it('approves a READY proposal and creates an execution request', async () => { const test = setup(); const request = await test.service.approve('telegram-42', '7'); expect(request.status).toBe('APPROVED'); expect(test.proposal.executionStatus).toBe('APPROVED'); });
  it('rejects an unauthorized Telegram user', async () => { const test = setup(); await expect(test.service.approve('telegram-9', '7')).rejects.toBeInstanceOf(ProposalUnauthorizedError); });
  it('prevents duplicate approvals', async () => { const test = setup(); await test.service.approve('telegram-42', '7'); await expect(test.service.approve('telegram-42', '7')).rejects.toBeInstanceOf(ProposalAlreadyProcessedError); expect(test.requests.createIfAbsent).toHaveBeenCalledTimes(1); });
  it('supports Skip by rejecting the proposal', async () => { const test = setup(); await test.service.reject('telegram-42', '7'); expect(test.proposal.executionStatus).toBe('REJECTED'); });
  it('expires an old proposal before approval', async () => { const test = setup({ ...base(), expiresAt: new Date(Date.now() - 1) }); await expect(test.service.approve('telegram-42', '7')).rejects.toBeInstanceOf(ProposalExpiredError); expect(test.proposal.executionStatus).toBe('EXPIRED'); });
  it('rejects already processed proposals', async () => { const test = setup({ ...base(), executionStatus: 'REJECTED' }); await expect(test.service.approve('telegram-42', '7')).rejects.toBeInstanceOf(ProposalAlreadyProcessedError); });
  it('requires destination-wallet ownership, not only proposal user linkage', async () => { const test = setup({ ...base(), userId: '9' }); await expect(test.service.approve('telegram-42', '7')).rejects.toBeInstanceOf(ProposalUnauthorizedError); });
  it('does not broadcast through the unconfigured executor', async () => { const executor = new UnconfiguredTransactionExecutor(); await expect(executor.execute(base())).rejects.toThrow('execution is not configured'); });
});

describe('READY proposal notification', () => {
  it('sends an explicit Execute/Skip notification', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const bot = { telegram: { sendMessage } };
    const proposals = { getNotificationDetails: vi.fn(async () => ({ execution_status: 'READY', telegram_user_id: 'telegram-42', nft_contract_address: wallet, chain_name: 'Test', source_transaction_hash: '0x' + 'a'.repeat(64), destination_wallet: wallet, quantity: '1', native_value: '2', gas_limit: '100000', strategy: 'PUBLIC_MINT', simulation_status: 'SUCCESS' })) };
    await new ProposalNotifier(bot as never, proposals as never).notifyReady('7');
    expect(sendMessage).toHaveBeenCalledWith('telegram-42', expect.stringContaining('Copy mint proposal ready'), expect.objectContaining({ reply_markup: expect.anything() }));
  });
});
