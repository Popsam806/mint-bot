import { createPublicClient, http, webSocket, type PublicClient } from 'viem';
import type { EvmChainConfig } from '../../config/chains.js';
import { ConfigurationError } from '../../utils/errors.js';

export class EvmChainManager {
  private readonly chains = new Map<number, EvmChainConfig>();
  private readonly httpClients = new Map<number, PublicClient>();
  private readonly websocketClients = new Map<number, PublicClient>();

  constructor(configs: EvmChainConfig[]) {
    for (const config of configs) this.chains.set(config.id, config);
  }

  getConfiguredChains(): readonly EvmChainConfig[] {
    return [...this.chains.values()];
  }

  getChain(chainId: number): EvmChainConfig {
    const chain = this.chains.get(chainId);
    if (!chain) throw new ConfigurationError(`Chain ${chainId} is not configured`);
    return chain;
  }

  getPublicClient(chainId: number): PublicClient {
    const existing = this.httpClients.get(chainId);
    if (existing) return existing;
    const config = this.getChain(chainId);
    const client = createPublicClient({ chain: config.viemChain, transport: http(config.rpcUrl) });
    this.httpClients.set(chainId, client);
    return client;
  }

  getWebSocketClient(chainId: number): PublicClient {
    const existing = this.websocketClients.get(chainId);
    if (existing) return existing;
    const config = this.getChain(chainId);
    if (!config.websocketRpcUrl) throw new ConfigurationError(`Chain ${chainId} has no WebSocket RPC URL`);
    const client = createPublicClient({ chain: config.viemChain, transport: webSocket(config.websocketRpcUrl) });
    this.websocketClients.set(chainId, client);
    return client;
  }
}
