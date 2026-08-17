import { isAddress } from 'viem';
import type { ExecutionSettingsUpdate, UserExecutionSettingsRepository } from '../database/repositories/user-execution-settings-repository.js';
import type { UserExecutionSettings } from '../database/types.js';

export class ExecutionSettingsService {
  constructor(private readonly repository: UserExecutionSettingsRepository) {}
  get(userId: string): Promise<UserExecutionSettings> { return this.repository.getOrCreate(userId); }
  update(userId: string, input: ExecutionSettingsUpdate): Promise<UserExecutionSettings> {
    if (input.destinationWallet !== undefined && input.destinationWallet !== null && !isAddress(input.destinationWallet)) throw new Error('Invalid destination wallet');
    if (input.allowedContracts?.some((address) => !isAddress(address))) throw new Error('Invalid allowed contract address');
    for (const value of [input.maxNativeValue, input.maxGas, input.maxQuantity]) if (value !== undefined && value !== null && BigInt(value) < 0n) throw new Error('Execution limits cannot be negative');
    if (input.executionMode === 'AUTO' && !input.destinationWallet) throw new Error('AUTO mode requires a destination wallet in the same update');
    return this.repository.update(userId, input);
  }
}
