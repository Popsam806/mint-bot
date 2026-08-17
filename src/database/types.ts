export interface User {
  id: string;
  telegramUserId: string;
  username: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChainRecord {
  id: string;
  chainId: string;
  name: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MonitoredAddress {
  id: string;
  userId: string;
  chainId: string;
  walletAddress: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type DetectedMintStatus = 'detected' | 'reviewed' | 'dismissed';

export interface DetectedMint {
  id: string;
  detectedTransactionId: string;
  monitoredAddressId: string;
  chainId: string;
  transactionHash: string;
  nftStandard: 'ERC721' | 'ERC1155';
  nftContractAddress: string;
  tokenId: string;
  quantity: string;
  recipientAddress: string;
  blockNumber: string;
  logIndex: number;
  batchIndex: number;
  detectedAt: Date;
  status: DetectedMintStatus;
}

export interface DetectedTransaction {
  id: string;
  monitoredAddressId: string;
  chainId: string;
  transactionHash: string;
  blockNumber: string;
  fromAddress: string;
  toAddress: string | null;
  transactionValue: string;
  inputData: string;
  gasLimit: string | null;
  gasPrice: string | null;
  effectiveGasPrice: string | null;
  detectedAt: Date;
  status: 'PENDING' | 'MINED' | 'REPLACED' | 'DROPPED' | 'REVERTED' | 'INVALIDATED' | 'detected' | 'confirmed' | 'reorged';
  analysisStatus: 'pending' | 'analyzing' | 'analyzed' | 'failed';
  analyzedAt: Date | null;
  nonce: string | null; originalTransactionHash: string; replacementTransactionId: string | null;
  firstSeenAt: Date; lastSeenAt: Date; observedAt: Date; ingestedAt: Date;
  analysisStartedAt: Date | null; analysisCompletedAt: Date | null; minedBlockNumber: string | null;
  providerObservation: string | null;
}

export type MintStrategy = 'PUBLIC_MINT' | 'MERKLE_ALLOWLIST' | 'SIGNATURE_AUTHORIZED' | 'UNKNOWN';
export type EligibilityStatus = 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'ELIGIBILITY_UNKNOWN';
export type ProposalStatus = 'READY' | 'ELIGIBILITY_REQUIRED' | 'NOT_ELIGIBLE' | 'ELIGIBILITY_UNKNOWN' | 'UNSUPPORTED';
export type SimulationStatus = 'NOT_RUN' | 'SUCCESS' | 'REVERTED' | 'FAILED';
export type ExecutionStatus = 'PENDING' | 'READY' | 'APPROVAL_REQUIRED' | 'APPROVED' | 'REJECTED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'EXPIRED';

export interface CopyTransactionProposal {
  id: string; userId: string | null; detectedMintId: string | null; detectedTransactionId?: string | null; mintQuantity?: string; sourceTransactionHash: string; destinationWallet: string; chainId: string;
  strategy: MintStrategy; eligibilityStatus: EligibilityStatus; targetContract: string | null; calldata: string | null;
  nativeValue: string | null; gasLimit: string | null; simulationStatus: SimulationStatus; simulationError: string | null;
  proposalStatus: ProposalStatus; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; executionStatus: ExecutionStatus; expiresAt: Date | null; explanation: string; createdAt: Date; updatedAt: Date;
}

export interface ExecutionRequest { id: string; proposalId: string; userId: string; status: 'APPROVED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED'; createdAt: Date; updatedAt: Date; }

export type ExecutionMode = 'DISABLED' | 'TELEGRAM_APPROVAL' | 'AUTO';
export interface UserExecutionSettings {
  userId: string; executionMode: ExecutionMode; destinationWallet: string | null;
  allowedChains: string[]; allowedContracts: string[]; maxNativeValue: string | null;
  maxGas: string | null; maxQuantity: string | null; proposalExpirationSeconds: number;
  autoRetryEnabled: boolean; createdAt: Date; updatedAt: Date;
}

export type ExecutionAttemptStatus = 'PENDING' | 'CLAIMED' | 'SIMULATING' | 'SIGNING' | 'SIGNED' | 'BROADCASTING' | 'SUBMITTED' | 'CONFIRMED' | 'REVERTED' | 'FAILED' | 'SKIPPED' | 'RETRY' | 'UNKNOWN';
export interface ExecutionAttempt {
  id: string; proposalId: string; sourceTransactionHash: string; destinationWallet: string;
  chainId: string; status: ExecutionAttemptStatus; copyTransactionHash: string | null;
  nonce: string | null; gasEstimate: string | null; nativeValue: string | null;
  failureReason: string | null; retryCount: number; executionStartedAt: Date;
}
