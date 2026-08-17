import type { ChainRecord, DetectedMint, MonitoredAddress, User } from '../types.js';

type Row = Record<string, unknown>;
const text = (value: unknown): string => String(value);

export const mapUser = (row: Row): User => ({ id: text(row.id), telegramUserId: text(row.telegram_user_id), username: row.username as string | null, createdAt: row.created_at as Date, updatedAt: row.updated_at as Date });
export const mapChain = (row: Row): ChainRecord => ({ id: text(row.id), chainId: text(row.chain_id), name: text(row.name), enabled: Boolean(row.enabled), createdAt: row.created_at as Date, updatedAt: row.updated_at as Date });
export const mapMonitoredAddress = (row: Row): MonitoredAddress => ({ id: text(row.id), userId: text(row.user_id), chainId: text(row.chain_id), walletAddress: text(row.wallet_address), enabled: Boolean(row.enabled), createdAt: row.created_at as Date, updatedAt: row.updated_at as Date });
export const mapDetectedMint = (row: Row): DetectedMint => ({ id: text(row.id), detectedTransactionId: text(row.detected_transaction_id), monitoredAddressId: text(row.monitored_address_id), chainId: text(row.chain_id), transactionHash: text(row.transaction_hash), nftStandard: row.nft_standard as DetectedMint['nftStandard'], nftContractAddress: text(row.nft_contract_address), tokenId: text(row.token_id), quantity: text(row.quantity), recipientAddress: text(row.recipient_address), blockNumber: text(row.block_number), logIndex: Number(row.log_index), batchIndex: Number(row.batch_index), detectedAt: row.detected_at as Date, status: row.status as DetectedMint['status'] });
