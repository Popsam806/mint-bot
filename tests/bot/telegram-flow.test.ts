import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineChain } from 'viem';
import { migrateUp } from '../../src/database/migrations.js';
import { UserRepository } from '../../src/database/repositories/user-repository.js';
import { ChainRepository } from '../../src/database/repositories/chain-repository.js';
import { MonitoredAddressRepository } from '../../src/database/repositories/monitored-address-repository.js';
import { DetectedTransactionRepository } from '../../src/database/repositories/detected-transaction-repository.js';
import { DetectedMintRepository } from '../../src/database/repositories/detected-mint-repository.js';
import { CopyTransactionProposalRepository } from '../../src/database/repositories/copy-transaction-proposal-repository.js';
import { ExecutionAttemptRepository } from '../../src/database/repositories/execution-attempt-repository.js';
import { MonitoringService, DuplicateMonitoringError, InvalidWalletAddressError, UnknownChainError } from '../../src/services/monitoring-service.js';
import type { EvmChainConfig } from '../../src/config/chains.js';

const memory = newDb();
memory.public.registerFunction({ name: 'length', args: ['text'], returns: 'integer', implementation: (value: string) => value.length });
const adapter = memory.adapters.createPg();
const pool = new adapter.Pool() as unknown as Pool;
const configuredChain: EvmChainConfig = {
  id: 777777,
  name: 'Configured Test EVM',
  rpcUrl: 'https://rpc.example.test',
  blockExplorerUrl: 'https://explorer.example.test',
  nativeCurrency: { name: 'Test Coin', symbol: 'TST', decimals: 18 },
  viemChain: defineChain({ id: 777777, name: 'Configured Test EVM', nativeCurrency: { name: 'Test Coin', symbol: 'TST', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.example.test'] } } }),
};
const users = new UserRepository(pool);
const chains = new ChainRepository(pool);
const addresses = new MonitoredAddressRepository(pool);
const service = new MonitoringService(users, chains, addresses, () => [configuredChain]);
const wallet = '0x0000000000000000000000000000000000000010';

describe('Telegram command flows', () => {
  beforeAll(() => migrateUp(pool));
  beforeEach(async () => {
    await pool.query('DELETE FROM copy_transaction_proposals');
    await pool.query('DELETE FROM monitoring_checkpoints');
    await pool.query('DELETE FROM detected_mints');
    await pool.query('DELETE FROM detected_transactions');
    await pool.query('DELETE FROM monitored_addresses');
    await pool.query('DELETE FROM chains');
    await pool.query('DELETE FROM users');
  });

  it('/start creates a user', async () => {
    const user = await service.ensureUser('123456789012345678', 'alice');
    expect((await users.findByTelegramUserId(user.telegramUserId))?.username).toBe('alice');
  });

  it('/start does not create duplicate users', async () => {
    await service.ensureUser('1234', 'first');
    await service.ensureUser('1234', 'updated');
    const result = await pool.query('SELECT COUNT(*) AS count FROM users WHERE telegram_user_id = $1', ['1234']);
    expect(Number(result.rows[0].count)).toBe(1);
  });

  it('/watch registers a valid wallet', async () => {
    const user = await service.ensureUser('1', null);
    const monitored = await service.watch(user.id, wallet, String(configuredChain.id));
    expect(monitored.walletAddress).toBe(wallet);
  });

  it('/watch rejects an invalid wallet', async () => {
    const user = await service.ensureUser('2', null);
    await expect(service.watch(user.id, 'not-an-address', String(configuredChain.id))).rejects.toBeInstanceOf(InvalidWalletAddressError);
  });

  it('/watch rejects an unknown chain', async () => {
    const user = await service.ensureUser('3', null);
    await expect(service.watch(user.id, wallet, '999')).rejects.toBeInstanceOf(UnknownChainError);
  });

  it('/watch rejects duplicate monitoring', async () => {
    const user = await service.ensureUser('4', null);
    await service.watch(user.id, wallet, String(configuredChain.id));
    await expect(service.watch(user.id, wallet, String(configuredChain.id))).rejects.toBeInstanceOf(DuplicateMonitoringError);
  });

  it('/status returns monitored addresses with chain names', async () => {
    const user = await service.ensureUser('5', null);
    await service.watch(user.id, wallet, String(configuredChain.id));
    expect(await service.status(user.id)).toMatchObject([{ walletAddress: wallet, chainName: configuredChain.name, enabled: true }]);
  });

  it('/stop disables a monitored address', async () => {
    const user = await service.ensureUser('6', null);
    const monitored = await service.watch(user.id, wallet, String(configuredChain.id));
    expect(await service.stop(user.id, monitored.id)).toBe(true);
    expect((await service.status(user.id))[0]?.enabled).toBe(false);
  });

  it('excludes disabled wallets from the active monitoring list and can re-enable them', async () => {
    const user = await service.ensureUser('10', null); const monitored = await service.watch(user.id, wallet, String(configuredChain.id));
    expect(await service.remove(user.id, monitored.id)).toBe(true);
    expect(await addresses.listEnabledByChain()).toEqual([]);
    expect(await service.start(user.id, monitored.id)).toBe(true);
    expect(await addresses.listEnabledByChain()).toMatchObject([{ id: monitored.id, enabled: true }]);
  });

  it('does not allow one user to remove another user\'s wallet', async () => {
    const owner = await service.ensureUser('7', null); const attacker = await service.ensureUser('8', null);
    const monitored = await service.watch(owner.id, wallet, String(configuredChain.id));
    expect(await service.remove(attacker.id, monitored.id)).toBe(false);
    expect((await addresses.findById(monitored.id))?.enabled).toBe(true);
  });

  it('soft-removes monitoring while preserving historical and execution records', async () => {
    const user = await service.ensureUser('9', null); const monitored = await service.watch(user.id, wallet, String(configuredChain.id));
    const transaction = await new DetectedTransactionRepository(pool).upsertPending({ monitoredAddressId: monitored.id, chainId: monitored.chainId,
      transaction: { hash: `0x${'9'.repeat(64)}`, from: wallet, to: '0x0000000000000000000000000000000000000020', nonce: 1n, value: 1n, input: '0x1234', gas: 21_000n, gasPrice: 1n, maxFeePerGas: null, maxPriorityFeePerGas: null },
      observation: { hash: `0x${'9'.repeat(64)}`, observedAt: new Date(), provider: 'test' } });
    const mint = await new DetectedMintRepository(pool).createIfAbsent({ detectedTransactionId: transaction.id, monitoredAddressId: monitored.id, chainId: monitored.chainId, transactionHash: transaction.transactionHash,
      nftStandard: 'ERC721', nftContractAddress: '0x0000000000000000000000000000000000000040', tokenId: '1', quantity: '1', recipientAddress: wallet, blockNumber: '1', logIndex: 0, batchIndex: 0 });
    const proposal = await new CopyTransactionProposalRepository(pool).createIfAbsent({ userId: user.id, detectedMintId: mint!.id, detectedTransactionId: transaction.id, mintQuantity: '1', sourceTransactionHash: transaction.transactionHash,
      destinationWallet: '0x0000000000000000000000000000000000000030', chainId: monitored.chainId, strategy: 'PUBLIC_MINT', eligibilityStatus: 'ELIGIBLE', targetContract: transaction.toAddress,
      calldata: transaction.inputData, nativeValue: '1', gasLimit: '21000', simulationStatus: 'SUCCESS', simulationError: null, proposalStatus: 'READY', confidence: 'HIGH', expiresAt: new Date(Date.now() + 10_000), explanation: 'test' });
    await new ExecutionAttemptRepository(pool).claim({ proposalId: proposal.id, sourceTransactionHash: transaction.transactionHash, destinationWallet: proposal.destinationWallet, chainId: monitored.chainId });

    expect(await service.remove(user.id, monitored.id)).toBe(true);
    expect(await addresses.listEnabledByChain()).toEqual([]);
    for (const table of ['monitored_addresses', 'detected_transactions', 'detected_mints', 'copy_transaction_proposals', 'execution_attempts']) {
      expect(Number((await pool.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count)).toBe(1);
    }
  });
});
