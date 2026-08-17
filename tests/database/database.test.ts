import { newDb } from 'pg-mem';
import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { migrateUp } from '../../src/database/migrations.js';
import { UserRepository } from '../../src/database/repositories/user-repository.js';
import { ChainRepository } from '../../src/database/repositories/chain-repository.js';
import { MonitoredAddressRepository } from '../../src/database/repositories/monitored-address-repository.js';
import { DetectedMintRepository } from '../../src/database/repositories/detected-mint-repository.js';
import { DetectedTransactionRepository } from '../../src/database/repositories/detected-transaction-repository.js';
import { CopyTransactionProposalRepository } from '../../src/database/repositories/copy-transaction-proposal-repository.js';
import { UserExecutionSettingsRepository } from '../../src/database/repositories/user-execution-settings-repository.js';
import { ExecutionAttemptRepository } from '../../src/database/repositories/execution-attempt-repository.js';

const db = newDb();
db.public.registerFunction({ name: 'length', args: ['text'], returns: 'integer', implementation: (value: string) => value.length });
const adapter = db.adapters.createPg();
const pool = new adapter.Pool() as unknown as Pool;

describe('database layer', () => {
  beforeAll(async () => {
    await migrateUp(pool);
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM execution_attempts');
    await pool.query('DELETE FROM user_execution_settings');
    await pool.query('DELETE FROM copy_transaction_proposals');
    await pool.query('DELETE FROM monitoring_checkpoints');
    await pool.query('DELETE FROM detected_mints');
    await pool.query('DELETE FROM detected_transactions');
    await pool.query('DELETE FROM monitored_addresses');
    await pool.query('DELETE FROM chains');
    await pool.query('DELETE FROM users');
  });

  it('defaults automatic execution to DISABLED and persists explicit settings', async () => {
    const user = await new UserRepository(pool).create('707');
    const settings = new UserExecutionSettingsRepository(pool);
    expect((await settings.getOrCreate(user.id)).executionMode).toBe('DISABLED');
    const updated = await settings.update(user.id, { executionMode: 'AUTO', destinationWallet: '0x0000000000000000000000000000000000000707', allowedChains: ['1'], maxGas: '200000' });
    expect(updated).toMatchObject({ executionMode: 'AUTO', allowedChains: ['1'], maxGas: '200000' });
  });

  it('atomically prevents duplicate execution claims and permits controlled RETRY reclaim', async () => {
    const user = await new UserRepository(pool).create('708'); const chain = await new ChainRepository(pool).create('708', 'Execution Test');
    const monitored = await new MonitoredAddressRepository(pool).create({ userId: user.id, chainId: chain.id, walletAddress: '0x0000000000000000000000000000000000000708' });
    const transaction = await new DetectedTransactionRepository(pool).upsertPending({ monitoredAddressId: monitored.id, chainId: chain.id,
      transaction: { hash: `0x${'7'.repeat(64)}`, from: monitored.walletAddress, to: '0x0000000000000000000000000000000000000709', nonce: 1n, value: 1n, input: '0x1234', gas: 1n, gasPrice: 1n, maxFeePerGas: null, maxPriorityFeePerGas: null },
      observation: { hash: `0x${'7'.repeat(64)}`, observedAt: new Date(), provider: 'test' } });
    const proposal = await new CopyTransactionProposalRepository(pool).createIfAbsent({ userId: user.id, detectedMintId: null, detectedTransactionId: transaction.id, mintQuantity: '1', sourceTransactionHash: transaction.transactionHash,
      destinationWallet: '0x0000000000000000000000000000000000000710', chainId: chain.id, strategy: 'PUBLIC_MINT', eligibilityStatus: 'ELIGIBLE', targetContract: transaction.toAddress,
      calldata: transaction.inputData, nativeValue: '1', gasLimit: '1', simulationStatus: 'SUCCESS', simulationError: null, proposalStatus: 'READY', confidence: 'HIGH', expiresAt: new Date(Date.now() + 10000), explanation: 'test' });
    const attempts = new ExecutionAttemptRepository(pool); const claim = { proposalId: proposal.id, sourceTransactionHash: transaction.transactionHash, destinationWallet: proposal.destinationWallet, chainId: chain.id };
    const first = await attempts.claim(claim); expect(first).not.toBeNull(); expect(await attempts.claim(claim)).toBeNull();
    await attempts.transition(first!.id, 'RETRY', { retry: true });
    expect((await attempts.claim({ ...claim, allowRetry: true }))?.id).toBe(first!.id);
  });

  it('prevents duplicate copy proposals for the same source and destination', async () => {
    const user = await new UserRepository(pool).create('801'); const chain = await new ChainRepository(pool).create('801', 'Proposal Test');
    const monitored = await new MonitoredAddressRepository(pool).create({ userId: user.id, chainId: chain.id, walletAddress: '0x0000000000000000000000000000000000000801' });
    const transaction = await new DetectedTransactionRepository(pool).createIfAbsent({ monitoredAddressId: monitored.id, chainId: chain.id, transactionHash: '0x' + '8'.repeat(64), blockNumber: '8', fromAddress: monitored.walletAddress, toAddress: null, transactionValue: '0', inputData: '0x', gasLimit: null, gasPrice: null, effectiveGasPrice: null });
    const mint = await new DetectedMintRepository(pool).createIfAbsent({ detectedTransactionId: transaction!.id, monitoredAddressId: monitored.id, chainId: chain.id, transactionHash: transaction!.transactionHash, nftStandard: 'ERC721', nftContractAddress: '0x0000000000000000000000000000000000000802', tokenId: '1', quantity: '1', recipientAddress: monitored.walletAddress, blockNumber: '8', logIndex: 0, batchIndex: 0 });
    const proposals = new CopyTransactionProposalRepository(pool);
    const input = { detectedMintId: mint!.id, sourceTransactionHash: transaction!.transactionHash, destinationWallet: '0x0000000000000000000000000000000000000803', chainId: chain.id, strategy: 'UNKNOWN' as const, eligibilityStatus: 'ELIGIBILITY_UNKNOWN' as const, targetContract: null, calldata: null, nativeValue: null, gasLimit: null, simulationStatus: 'NOT_RUN' as const, simulationError: null, proposalStatus: 'UNSUPPORTED' as const, confidence: 'LOW' as const, explanation: 'Unsupported' };
    expect((await proposals.createIfAbsent(input)).id).toBe((await proposals.createIfAbsent(input)).id);
    expect(Number((await pool.query('SELECT COUNT(*) AS count FROM copy_transaction_proposals')).rows[0].count)).toBe(1);
  });

  it('persists detected transactions idempotently', async () => {
    const user = await new UserRepository(pool).create('701');
    const chain = await new ChainRepository(pool).create('701', 'Transaction Test');
    const monitored = await new MonitoredAddressRepository(pool).create({ userId: user.id, chainId: chain.id, walletAddress: '0x0000000000000000000000000000000000000701' });
    const transactions = new DetectedTransactionRepository(pool);
    const input = { monitoredAddressId: monitored.id, chainId: chain.id, transactionHash: '0x' + 'c'.repeat(64), blockNumber: '9', fromAddress: monitored.walletAddress, toAddress: null, transactionValue: '1', inputData: '0x', gasLimit: '21000', gasPrice: '2', effectiveGasPrice: null };
    expect(await transactions.createIfAbsent(input)).not.toBeNull();
    expect(await transactions.createIfAbsent(input)).toBeNull();
    expect(Number((await pool.query('SELECT COUNT(*) AS count FROM detected_transactions')).rows[0].count)).toBe(1);
  });

  it('applies migrations successfully', async () => {
    const result = await pool.query("SELECT DISTINCT table_name FROM information_schema.tables WHERE table_name IN ('users','chains','monitored_addresses','detected_mints') ORDER BY table_name");
    expect(result.rows.map((row) => row.table_name)).toEqual(['chains', 'detected_mints', 'monitored_addresses', 'users']);
  });

  it('rejects duplicate monitored addresses for the same user and chain', async () => {
    const user = await new UserRepository(pool).create('9007199254740991');
    const chain = await new ChainRepository(pool).create('1', 'Test Network');
    const addresses = new MonitoredAddressRepository(pool);
    await addresses.create({ userId: user.id, chainId: chain.id, walletAddress: '0x0000000000000000000000000000000000000001' });
    await expect(addresses.create({ userId: user.id, chainId: chain.id, walletAddress: '0x0000000000000000000000000000000000000001' })).rejects.toThrow();
  });

  it('persists NFT mint events idempotently', async () => {
    const user = await new UserRepository(pool).create('123456789012345678');
    const chain = await new ChainRepository(pool).create('8453', 'Test Network');
    const address = await new MonitoredAddressRepository(pool).create({ userId: user.id, chainId: chain.id, walletAddress: '0x0000000000000000000000000000000000000002' });
    const transaction = await new DetectedTransactionRepository(pool).createIfAbsent({ monitoredAddressId: address.id, chainId: chain.id, transactionHash: '0x' + 'a'.repeat(64), blockNumber: '100', fromAddress: address.walletAddress, toAddress: null, transactionValue: '0', inputData: '0x', gasLimit: null, gasPrice: null, effectiveGasPrice: null });
    const mints = new DetectedMintRepository(pool);
    const input = { detectedTransactionId: transaction!.id, monitoredAddressId: address.id, chainId: chain.id, transactionHash: transaction!.transactionHash, nftStandard: 'ERC721' as const, nftContractAddress: '0x0000000000000000000000000000000000000003', tokenId: '1', quantity: '1', recipientAddress: address.walletAddress, blockNumber: '100', logIndex: 0, batchIndex: 0 };
    expect(await mints.createIfAbsent(input)).not.toBeNull();
    expect(await mints.createIfAbsent(input)).toBeNull();
  });

  it('enforces foreign-key relationships', async () => {
    const addresses = new MonitoredAddressRepository(pool);
    await expect(addresses.create({ userId: '999', chainId: '999', walletAddress: '0x0000000000000000000000000000000000000004' })).rejects.toThrow();
  });

  it('supports basic CRUD operations through repositories', async () => {
    const users = new UserRepository(pool);
    const chains = new ChainRepository(pool);
    const addresses = new MonitoredAddressRepository(pool);
    const mints = new DetectedMintRepository(pool);
    const user = await users.create('987654321', 'alice');
    expect((await users.updateUsername(user.id, 'alice-updated'))?.username).toBe('alice-updated');
    const chain = await chains.create('999999', 'Generic EVM');
    const address = await addresses.create({ userId: user.id, chainId: chain.id, walletAddress: '0x0000000000000000000000000000000000000005' });
    expect((await addresses.listByUser(user.id))).toHaveLength(1);
    const transaction = await new DetectedTransactionRepository(pool).createIfAbsent({ monitoredAddressId: address.id, chainId: chain.id, transactionHash: '0x' + 'b'.repeat(64), blockNumber: '12', fromAddress: address.walletAddress, toAddress: null, transactionValue: '0', inputData: '0x', gasLimit: null, gasPrice: null, effectiveGasPrice: null });
    const mint = await mints.createIfAbsent({ detectedTransactionId: transaction!.id, monitoredAddressId: address.id, chainId: chain.id, transactionHash: transaction!.transactionHash, nftStandard: 'ERC1155', nftContractAddress: '0x0000000000000000000000000000000000000006', tokenId: '7', quantity: '2', recipientAddress: address.walletAddress, blockNumber: '12', logIndex: 1, batchIndex: 0 });
    expect((await mints.setStatus(mint!.id, 'reviewed'))?.status).toBe('reviewed');
    expect(await users.delete(user.id)).toBe(true);
    expect(await mints.findById(mint!.id)).toBeNull();
  });
});
