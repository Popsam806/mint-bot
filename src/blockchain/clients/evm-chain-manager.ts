import { createPublicClient, fallback, http, webSocket, type PublicClient } from 'viem';
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
    const transports = config.rpcUrls.map((url) => http(url, { retryCount: 2, retryDelay: 250 }));
    const client = createPublicClient({ chain: config.viemChain, transport: transports.length === 1 ? transports[0]! : fallback(transports, { rank: true }) });
    this.httpClients.set(chainId, client);
    return client;
  }

  getWebSocketClient(chainId: number): PublicClient {
    const existing = this.websocketClients.get(chainId);
    if (existing) return existing;
    const config = this.getChain(chainId);
    if (!config.websocketRpcUrl) throw new ConfigurationError(`Chain ${chainId} has no WebSocket RPC URL`);
    const transports = config.websocketRpcUrls.map((url) => webSocket(url, { reconnect: { attempts: 10, delay: 1_000 } }));
    const client = createPublicClient({ chain: config.viemChain, transport: transports.length === 1 ? transports[0]! : fallback(transports) });
    this.websocketClients.set(chainId, client);
    return client;
  }
}
