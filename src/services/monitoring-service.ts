import type { EvmChainConfig } from '../config/chains.js';
import type { ChainRepository } from '../database/repositories/chain-repository.js';
import type { MonitoredAddressRepository } from '../database/repositories/monitored-address-repository.js';
import type { UserRepository } from '../database/repositories/user-repository.js';
import type { User } from '../database/types.js';
import { isAddress } from 'viem';

export class InvalidWalletAddressError extends Error {}
export class UnknownChainError extends Error {}
export class DisabledChainError extends Error {}
export class DuplicateMonitoringError extends Error {}
export type MonitoringStateChangeHandler = () => Promise<void>;

export class MonitoringService {
  constructor(
    private readonly users: UserRepository,
    private readonly chains: ChainRepository,
    private readonly addresses: MonitoredAddressRepository,
    private readonly configuredChains: () => readonly EvmChainConfig[],
    private readonly onStateChange?: MonitoringStateChangeHandler,
  ) {}

  async ensureUser(telegramUserId: string, username: string | null): Promise<User> {
    return this.users.findOrCreate(telegramUserId, username);
  }

  validateWalletAddress(walletAddress: string): void {
    if (!isAddress(walletAddress)) throw new InvalidWalletAddressError();
  }

  async watch(userId: string, walletAddress: string, configuredChainId: string) {
    this.validateWalletAddress(walletAddress);
    const config = this.configuredChains().find(({ id }) => String(id) === configuredChainId);
    if (!config) throw new UnknownChainError();
    const chain = (await this.chains.findByChainId(String(config.id))) ?? await this.chains.findOrCreate(String(config.id), config.name, true);
    if (!chain.enabled) throw new DisabledChainError();
    try {
      return await this.addresses.create({ userId, chainId: chain.id, walletAddress });
    } catch (error) {
      if (error instanceof Error && /unique|duplicate/i.test(error.message)) throw new DuplicateMonitoringError();
      throw error;
    }
  }

  async status(userId: string) {
    return this.addresses.listByUserWithChain(userId);
  }

  async configuredChainStatus() {
    return Promise.all(this.configuredChains().map(async (config) => {
      const chain = await this.chains.findByChainId(String(config.id));
      return { id: config.id, name: config.name, enabled: chain?.enabled ?? true };
    }));
  }

  async stop(userId: string, addressId: string): Promise<boolean> {
    return this.remove(userId, addressId);
  }

  async remove(userId: string, addressId: string): Promise<boolean> {
    const address = await this.addresses.findById(addressId);
    if (!address || address.userId !== userId) return false;
    await this.addresses.setEnabled(addressId, false);
    await this.onStateChange?.();
    return true;
  }

  async start(userId: string, addressId: string): Promise<boolean> {
    const address = await this.addresses.findById(addressId);
    if (!address || address.userId !== userId) return false;
    const chain = await this.chains.findById(address.chainId);
    if (!chain?.enabled) throw new DisabledChainError();
    await this.addresses.setEnabled(addressId, true);
    await this.onStateChange?.();
    return true;
  }
}
