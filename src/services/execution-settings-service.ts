import { isAddress } from 'viem';
import type { ExecutionSettingsUpdate, UserExecutionSettingsRepository } from '../database/repositories/user-execution-settings-repository.js';
import type { UserExecutionSettings } from '../database/types.js';

export class ExecutionSettingsService {
  constructor(private readonly repository: UserExecutionSettingsRepository) {}
  get(userId: string): Promise<UserExecutionSettings> { return this.repository.getOrCreate(userId); }
  async update(userId: string, input: ExecutionSettingsUpdate): Promise<UserExecutionSettings> {
    if (input.destinationWallet !== undefined && input.destinationWallet !== null && !isAddress(input.destinationWallet)) throw new Error('Invalid destination wallet');
    if (input.allowedContracts?.some((address) => !isAddress(address))) throw new Error('Invalid allowed contract address');
    if (input.allowedChains?.some((value) => !/^\d+$/.test(value) || BigInt(value) <= 0n)) throw new Error('Invalid allowed chain ID');
    for (const value of [input.maxNativeValue, input.maxGas, input.maxQuantity]) {
      if (value === undefined || value === null) continue;
      if (!/^\d+$/.test(value) || BigInt(value) < 0n) throw new Error('Execution limits must be non-negative integers');
    }
    const current = await this.repository.getOrCreate(userId);
    if (input.executionMode === 'AUTO' && !input.destinationWallet) throw new Error('AUTO mode requires a destination wallet in the same update');
    if (current.executionMode === 'AUTO' && input.destinationWallet === null) throw new Error('Disable AUTO before clearing the destination wallet');
    return this.repository.update(userId, input);
  }
}
