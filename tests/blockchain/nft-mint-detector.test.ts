import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, numberToHex, padHex, toEventSelector } from 'viem';
import { decodeNftMintEvents, type ReceiptLog } from '../../src/blockchain/decoders/nft-mint-event-decoder.js';
import { NftMintDetector } from '../../src/services/nft-mint-detector.js';
import type { DetectedTransaction, MonitoredAddress } from '../../src/database/types.js';

const zero = '0x0000000000000000000000000000000000000000';
const wallet = '0x0000000000000000000000000000000000000011';
const other = '0x0000000000000000000000000000000000000022';
const contractA = '0x00000000000000000000000000000000000000aa';
const contractB = '0x00000000000000000000000000000000000000bb';
const addressTopic = (address: string) => padHex(address as `0x${string}`, { size: 32 });
const uintTopic = (value: bigint) => padHex(numberToHex(value), { size: 32 });
const erc721 = (from = zero, to = wallet, tokenId = 1n, address = contractA, logIndex = 0): ReceiptLog => ({ address, logIndex, data: '0x', topics: [toEventSelector('Transfer(address,address,uint256)'), addressTopic(from), addressTopic(to), uintTopic(tokenId)] });
const single = (from = zero, to = wallet, id = 2n, quantity = 3n, address = contractA, logIndex = 0): ReceiptLog => ({ address, logIndex, topics: [toEventSelector('TransferSingle(address,address,address,uint256,uint256)'), addressTopic(other), addressTopic(from), addressTopic(to)], data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [id, quantity]) });
const batch = (from = zero, to = wallet, ids = [4n, 5n], quantities = [1n, 2n], address = contractA, logIndex = 0): ReceiptLog => ({ address, logIndex, topics: [toEventSelector('TransferBatch(address,address,address,uint256[],uint256[])'), addressTopic(other), addressTopic(from), addressTopic(to)], data: encodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], [ids, quantities]) });

describe('NFT mint event decoding', () => {
  it('detects an ERC-721 zero-address mint', () => expect(decodeNftMintEvents([erc721()], wallet)).toMatchObject([{ standard: 'ERC721', tokenId: 1n, quantity: 1n }]));
  it('detects an ERC-1155 TransferSingle mint', () => expect(decodeNftMintEvents([single()], wallet)).toMatchObject([{ standard: 'ERC1155', tokenId: 2n, quantity: 3n }]));
  it('expands an ERC-1155 TransferBatch mint', () => expect(decodeNftMintEvents([batch()], wallet).map((event) => [event.tokenId, event.quantity])).toEqual([[4n, 1n], [5n, 2n]]));
  it('rejects an ordinary ERC-721 transfer', () => expect(decodeNftMintEvents([erc721(other)], wallet)).toEqual([]));
  it('rejects an ordinary ERC-1155 transfer', () => expect(decodeNftMintEvents([single(other)], wallet)).toEqual([]));
  it('supports router mints by using the emitting log contract', () => expect(decodeNftMintEvents([erc721(zero, wallet, 8n, contractB)], wallet)[0]?.contractAddress).toBe(contractB));
  it('detects multiple NFTs in one transaction', () => expect(decodeNftMintEvents([erc721(), batch(zero, wallet, [9n, 10n], [1n, 1n], contractB, 1)], wallet)).toHaveLength(3));
  it('supports multiple NFT contracts in one transaction', () => expect(new Set(decodeNftMintEvents([erc721(zero, wallet, 1n, contractA), erc721(zero, wallet, 2n, contractB, 1)], wallet).map((event) => event.contractAddress))).toEqual(new Set([contractA, contractB])));
  it('ignores mints sent to a different wallet', () => expect(decodeNftMintEvents([erc721(zero, other)], wallet)).toEqual([]));
  it('ignores malformed and irrelevant logs', () => expect(decodeNftMintEvents([{ address: contractA, logIndex: 0, topics: ['0x1234'], data: '0xzz' }], wallet)).toEqual([]));
  it('keeps mint events while excluding unrelated transfers', () => expect(decodeNftMintEvents([erc721(), erc721(other, wallet, 2n), single(zero, wallet, 3n, 4n)], wallet)).toHaveLength(2));
});

describe('NftMintDetector', () => {
  const transaction: DetectedTransaction = { id: '1', monitoredAddressId: '2', chainId: '3', transactionHash: '0x' + 'a'.repeat(64), blockNumber: '10', fromAddress: wallet, toAddress: other, transactionValue: '0', inputData: '0x', gasLimit: null, gasPrice: null, effectiveGasPrice: null, detectedAt: new Date(), status: 'detected', analysisStatus: 'pending', analyzedAt: null };
  const monitored: MonitoredAddress = { id: '2', userId: '1', chainId: '3', walletAddress: wallet, enabled: true, createdAt: new Date(), updatedAt: new Date() };
  const logger = { info: vi.fn(), error: vi.fn() } as never;

  it('is idempotent when the same transaction is analyzed twice', async () => {
    const statuses = { setAnalysisStatus: vi.fn() };
    let inserted = false;
    const mints = { createIfAbsent: vi.fn(async () => inserted ? null : (inserted = true, { id: '1' })) };
    const detector = new NftMintDetector(statuses as never, mints as never, logger);
    const provider = { getReceipt: vi.fn(async () => ({ status: 'success' as const, blockNumber: 10n, logs: [erc721()] })) };
    expect(await detector.analyze(transaction, monitored, provider)).toBe(1);
    expect(await detector.analyze(transaction, monitored, provider)).toBe(0);
    expect(mints.createIfAbsent).toHaveBeenCalledTimes(2);
  });

  it('does not create mints for a failed receipt', async () => {
    const transactions = { setAnalysisStatus: vi.fn() }; const mints = { createIfAbsent: vi.fn() };
    const detector = new NftMintDetector(transactions as never, mints as never, logger);
    expect(await detector.analyze(transaction, monitored, { getReceipt: async () => ({ status: 'reverted', blockNumber: 10n, logs: [erc721()] }) })).toBe(0);
    expect(mints.createIfAbsent).not.toHaveBeenCalled();
  });
});
