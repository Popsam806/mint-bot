import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadChainConfigs } from '../../src/config/chains.js';
import { ConfigurationError } from '../../src/utils/errors.js';

const configPath = resolve('config/chains.json');
const rpcEnvironment = {
  ETHEREUM_RPC_URL: 'https://ethereum.example.test',
  ETHEREUM_WS_RPC_URL: 'wss://ethereum.example.test',
  BASE_RPC_URL: 'https://base.example.test',
  BASE_WS_RPC_URL: 'wss://base.example.test',
  ROBINHOOD_RPC_URL: 'https://robinhood.example.test',
  ROBINHOOD_WS_RPC_URL: 'wss://robinhood.example.test',
};

describe('chain configuration', () => {
  it('loads the supported mainnets and resolves separate RPC endpoints from the environment', () => {
    const chains = loadChainConfigs(configPath, rpcEnvironment);

    expect(chains.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 1, name: 'Ethereum' },
      { id: 8453, name: 'Base' },
      { id: 4663, name: 'Robinhood Chain' },
    ]);
    expect(chains[0]).toMatchObject({
      rpcUrl: rpcEnvironment.ETHEREUM_RPC_URL,
      websocketRpcUrl: rpcEnvironment.ETHEREUM_WS_RPC_URL,
      pendingTransactionMode: 'websocket',
    });
    expect(chains[0]?.viemChain.rpcUrls.default).toEqual({
      http: [rpcEnvironment.ETHEREUM_RPC_URL],
      webSocket: [rpcEnvironment.ETHEREUM_WS_RPC_URL],
    });
  });

  it('supports ordered comma-separated RPC failover endpoints', () => {
    const chains = loadChainConfigs(configPath, { ...rpcEnvironment, ETHEREUM_RPC_URL: 'https://primary.test, https://backup.test' });
    expect(chains[0]?.rpcUrls).toEqual(['https://primary.test', 'https://backup.test']);
  });

  it('fails when a configured RPC environment variable is missing', () => {
    const incompleteEnvironment: NodeJS.ProcessEnv = { ...rpcEnvironment };
    delete incompleteEnvironment.BASE_WS_RPC_URL;

    expect(() => loadChainConfigs(configPath, incompleteEnvironment)).toThrowError(
      new ConfigurationError('Environment variable BASE_WS_RPC_URL must contain valid comma-separated RPC URLs'),
    );
  });
});
