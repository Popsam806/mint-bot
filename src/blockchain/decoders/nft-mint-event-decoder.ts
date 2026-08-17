import { decodeAbiParameters, toEventSelector, type Hex } from 'viem';

const zeroAddress = '0x0000000000000000000000000000000000000000';
const transferTopic = toEventSelector('Transfer(address,address,uint256)').toLowerCase();
const transferSingleTopic = toEventSelector('TransferSingle(address,address,address,uint256,uint256)').toLowerCase();
const transferBatchTopic = toEventSelector('TransferBatch(address,address,address,uint256[],uint256[])').toLowerCase();

export interface ReceiptLog { address: string; topics: readonly string[]; data: string; logIndex: number; }
export interface MintEvent { standard: 'ERC721' | 'ERC1155'; contractAddress: string; tokenId: bigint; quantity: bigint; recipient: string; logIndex: number; batchIndex: number; }

function topicAddress(topic: string | undefined): string | null {
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return `0x${topic.slice(-40)}`.toLowerCase();
}

export function decodeNftMintEvents(logs: readonly ReceiptLog[], monitoredWallet: string): MintEvent[] {
  const recipient = monitoredWallet.toLowerCase();
  const events: MintEvent[] = [];
  for (const log of logs) {
    try {
      const signature = log.topics[0]?.toLowerCase();
      if (signature === transferTopic && log.topics.length === 4) {
        const from = topicAddress(log.topics[1]); const to = topicAddress(log.topics[2]);
        if (from === zeroAddress && to === recipient) events.push({ standard: 'ERC721', contractAddress: log.address, tokenId: BigInt(log.topics[3] as string), quantity: 1n, recipient, logIndex: log.logIndex, batchIndex: 0 });
      } else if (signature === transferSingleTopic && log.topics.length === 4) {
        const from = topicAddress(log.topics[2]); const to = topicAddress(log.topics[3]);
        if (from !== zeroAddress || to !== recipient) continue;
        const [tokenId, quantity] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], log.data as Hex);
        if (quantity > 0n) events.push({ standard: 'ERC1155', contractAddress: log.address, tokenId, quantity, recipient, logIndex: log.logIndex, batchIndex: 0 });
      } else if (signature === transferBatchTopic && log.topics.length === 4) {
        const from = topicAddress(log.topics[2]); const to = topicAddress(log.topics[3]);
        if (from !== zeroAddress || to !== recipient) continue;
        const [ids, quantities] = decodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], log.data as Hex);
        if (ids.length !== quantities.length) continue;
        ids.forEach((tokenId, index) => { const quantity = quantities[index]; if (quantity && quantity > 0n) events.push({ standard: 'ERC1155', contractAddress: log.address, tokenId, quantity, recipient, logIndex: log.logIndex, batchIndex: index }); });
      }
    } catch { /* Malformed or irrelevant logs are ignored. */ }
  }
  return events;
}
