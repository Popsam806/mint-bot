export interface MinedTransaction {
  hash: string; from: string; to: string | null; value: bigint; input: string;
  gas: bigint | null; gasPrice: bigint | null; effectiveGasPrice: bigint | null;
}

export interface MinedBlock { number: bigint; transactions: MinedTransaction[]; }

export interface ChainBlockProvider {
  getBlockNumber(): Promise<bigint>;
  getBlock(blockNumber: bigint): Promise<MinedBlock>;
  watchBlockNumbers(onBlock: (blockNumber: bigint) => void, onError: (error: unknown) => void): () => void;
}
