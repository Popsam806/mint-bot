import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, parseAbi } from 'viem';
import { analyzeMintCalldata } from '../../src/blockchain/decoders/mint-calldata-strategies.js';
import { CopyTransactionBuilder } from '../../src/services/copy-transaction-builder.js';
import { MintTransactionAnalyzer } from '../../src/services/mint-transaction-analyzer.js';
import type { CopyTransactionProposal, DetectedMint } from '../../src/database/types.js';
import type { SourceTransaction, TransactionAnalysisProvider } from '../../src/blockchain/clients/transaction-analysis-provider.js';

const sourceWallet = '0x0000000000000000000000000000000000000011';
const destination = '0x0000000000000000000000000000000000000022';
const router = '0x0000000000000000000000000000000000000033';
const collection = '0x0000000000000000000000000000000000000044';
const mint: DetectedMint = { id: '1', detectedTransactionId: '2', monitoredAddressId: '3', chainId: '4', transactionHash: '0x' + 'a'.repeat(64), nftStandard: 'ERC721', nftContractAddress: collection, tokenId: '1', quantity: '1', recipientAddress: sourceWallet, blockNumber: '10', logIndex: 0, batchIndex: 0, detectedAt: new Date(), status: 'detected' };
const simpleData = encodeFunctionData({ abi: parseAbi(['function mint(uint256 quantity) payable']), functionName: 'mint', args: [2n] });
const recipientData = encodeFunctionData({ abi: parseAbi(['function mint(address recipient,uint256 quantity) payable']), functionName: 'mint', args: [sourceWallet, 2n] });
const source = (input = simpleData, value = 5n): SourceTransaction => ({ hash: mint.transactionHash, chainId: 1, from: sourceWallet, to: router, value, input, gas: 500_000n, gasPrice: null, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, type: 'eip1559' });

function setup(transaction = source(), simulation: { success: true } | { success: false; error: string } = { success: true }) {
  const stored = new Map<string, CopyTransactionProposal>();
  const repository = { createIfAbsent: vi.fn(async (input: Omit<CopyTransactionProposal, 'id' | 'createdAt' | 'updatedAt'>) => { const key = `${input.chainId}:${input.sourceTransactionHash}:${input.destinationWallet}`; const existing = stored.get(key); if (existing) return existing; const proposal = { ...input, id: String(stored.size + 1), createdAt: new Date(), updatedAt: new Date() }; stored.set(key, proposal); return proposal; }) };
  const provider: TransactionAnalysisProvider = { getTransaction: vi.fn(async () => transaction), estimateGas: vi.fn(async () => 123_456n), simulate: vi.fn(async () => simulation) };
  const analyzer = new MintTransactionAnalyzer(new CopyTransactionBuilder(repository as never));
  return { analyzer, provider, repository, stored };
}

describe('mint transaction analysis and proposal building', () => {
  it('builds a simple public mint proposal', async () => expect((await setup().analyzer.analyze(mint, destination, setup().provider)).proposalStatus).toBe('READY'));
  it('decodes public mint quantity', () => expect(analyzeMintCalldata(simpleData, sourceWallet, destination).quantity).toBe(2n));
  it('replaces an explicit source recipient', () => expect(analyzeMintCalldata(recipientData, sourceWallet, destination)).toMatchObject({ strategy: 'PUBLIC_MINT', recipientReplaced: true }));
  it('uses the source target router rather than the NFT log contract', async () => { const test = setup(); expect((await test.analyzer.analyze(mint, destination, test.provider)).targetContract).toBe(router); });
  it('supports an ERC-721 detected mint', async () => { const test = setup(); expect((await test.analyzer.analyze(mint, destination, test.provider)).proposalStatus).toBe('READY'); });
  it('supports an ERC-1155 detected mint', async () => { const test = setup(); expect((await test.analyzer.analyze({ ...mint, nftStandard: 'ERC1155' }, destination, test.provider)).proposalStatus).toBe('READY'); });
  it('detects Merkle allowlist calldata without reusing it', async () => { const data = encodeFunctionData({ abi: parseAbi(['function allowlistMint(uint256 quantity,bytes32[] proof)']), functionName: 'allowlistMint', args: [1n, ['0x' + '1'.repeat(64) as `0x${string}`]] }); const test = setup(source(data)); expect(await test.analyzer.analyze(mint, destination, test.provider)).toMatchObject({ strategy: 'MERKLE_ALLOWLIST', proposalStatus: 'ELIGIBILITY_REQUIRED', calldata: null }); });
  it('detects signature-authorized calldata without reusing it', async () => { const data = encodeFunctionData({ abi: parseAbi(['function mint(uint256 quantity,bytes signature)']), functionName: 'mint', args: [1n, '0x1234'] }); const test = setup(source(data)); expect(await test.analyzer.analyze(mint, destination, test.provider)).toMatchObject({ strategy: 'SIGNATURE_AUTHORIZED', proposalStatus: 'ELIGIBILITY_REQUIRED', calldata: null }); });
  it('marks unknown calldata unsupported', async () => { const test = setup(source('0xdeadbeef')); expect((await test.analyzer.analyze(mint, destination, test.provider)).proposalStatus).toBe('UNSUPPORTED'); });
  it('encodes the destination wallet in supported recipient calldata', () => expect(analyzeMintCalldata(recipientData, sourceWallet, destination).calldata).not.toBe(recipientData));
  it('does not replace a recipient that differs from the source wallet', () => { const data = encodeFunctionData({ abi: parseAbi(['function mint(address recipient,uint256 quantity) payable']), functionName: 'mint', args: [router, 1n] }); expect(analyzeMintCalldata(data, sourceWallet, destination)).toMatchObject({ supported: false, strategy: 'UNKNOWN' }); });
  it('preserves value only for a recognized buildable mint', async () => { const test = setup(source(simpleData, 99n)); expect((await test.analyzer.analyze(mint, destination, test.provider)).nativeValue).toBe('99'); });
  it('uses fresh gas estimation instead of source gas', async () => { const test = setup(); expect((await test.analyzer.analyze(mint, destination, test.provider)).gasLimit).toBe('123456'); expect(test.provider.estimateGas).toHaveBeenCalled(); });
  it('records simulation success', async () => { const test = setup(); expect((await test.analyzer.analyze(mint, destination, test.provider)).simulationStatus).toBe('SUCCESS'); });
  it('records simulation revert without throwing', async () => { const test = setup(source(), { success: false, error: 'wallet limit' }); expect(await test.analyzer.analyze(mint, destination, test.provider)).toMatchObject({ simulationStatus: 'REVERTED', proposalStatus: 'NOT_ELIGIBLE', simulationError: 'wallet limit' }); });
  it('returns the existing proposal for duplicate analysis', async () => { const test = setup(); const first = await test.analyzer.analyze(mint, destination, test.provider); const second = await test.analyzer.analyze(mint, destination, test.provider); expect(second.id).toBe(first.id); });
  it('deduplicates multiple mint events from one source transaction', async () => { const test = setup(); await test.analyzer.analyze(mint, destination, test.provider); await test.analyzer.analyze({ ...mint, id: '99', tokenId: '2', logIndex: 1 }, destination, test.provider); expect(test.stored.size).toBe(1); });
});
