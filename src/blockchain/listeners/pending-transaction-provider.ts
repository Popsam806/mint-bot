export type PendingCapability = 'websocket' | 'filter' | 'polling' | 'unsupported';

export interface PendingSourceTransaction {
  hash: string; from: string; to: string | null; nonce: bigint; value: bigint; input: string;
  gas: bigint | null; gasPrice: bigint | null; maxFeePerGas: bigint | null; maxPriorityFeePerGas: bigint | null;
}

export interface PendingObservation { hash: string; observedAt: Date; provider: string; }

export interface PendingTransactionProvider {
  detectCapability(): Promise<PendingCapability>;
  subscribe(onObservation: (observation: PendingObservation) => void, onError: (error: unknown) => void): Promise<() => void>;
  poll(): Promise<PendingObservation[]>;
  getTransaction(hash: string): Promise<PendingSourceTransaction | null>;
}
