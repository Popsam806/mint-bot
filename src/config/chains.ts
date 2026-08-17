import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineChain, type Chain } from 'viem';
import { z } from 'zod';
import { ConfigurationError } from '../utils/errors.js';

const nativeCurrencySchema = z.object({
  name: z.string().min(1),
  symbol: z.string().min(1),
  decimals: z.number().int().nonnegative(),
});

const chainFileEntrySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  rpcUrlEnv: z.string().min(1),
  websocketRpcUrlEnv: z.string().min(1).optional(),
  blockExplorerUrl: z.string().url(),
  nativeCurrency: nativeCurrencySchema,
  pendingTransactionMode: z.enum(['websocket', 'filter', 'polling', 'unsupported']).default('unsupported'),
});

const chainsFileSchema = z.object({ chains: z.array(chainFileEntrySchema) });
const httpRpcUrlSchema = z.string().url().refine((url) => url.startsWith('http://') || url.startsWith('https://'));
const websocketRpcUrlSchema = z.string().url().refine((url) => url.startsWith('ws://') || url.startsWith('wss://'));

export type EvmChainConfig = Omit<z.infer<typeof chainFileEntrySchema>, 'rpcUrlEnv' | 'websocketRpcUrlEnv'> & {
  rpcUrl: string;
  rpcUrls: string[];
  websocketRpcUrl?: string;
  websocketRpcUrls: string[];
  viemChain: Chain;
};

function resolveRpcUrls(environment: NodeJS.ProcessEnv, variableName: string, schema: z.ZodType<string>): string[] {
  const values = (environment[variableName] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!values.length || values.some((value) => !schema.safeParse(value).success)) throw new ConfigurationError(`Environment variable ${variableName} must contain valid comma-separated RPC URLs`);
  return [...new Set(values)];
}

export function loadChainConfigs(configPath: string, environment: NodeJS.ProcessEnv = process.env): EvmChainConfig[] {
  const absolutePath = resolve(configPath);

  try {
    const parsed = chainsFileSchema.parse(JSON.parse(readFileSync(absolutePath, 'utf8')));
    const ids = new Set<number>();

    return parsed.chains.map((chain) => {
      if (ids.has(chain.id)) throw new ConfigurationError(`Duplicate chain ID: ${chain.id}`);
      ids.add(chain.id);
      const { rpcUrlEnv, websocketRpcUrlEnv, ...metadata } = chain;
      const rpcUrls = resolveRpcUrls(environment, rpcUrlEnv, httpRpcUrlSchema); const rpcUrl = rpcUrls[0]!;
      const websocketRpcUrls = websocketRpcUrlEnv ? resolveRpcUrls(environment, websocketRpcUrlEnv, websocketRpcUrlSchema) : [];
      const websocketRpcUrl = websocketRpcUrls[0];

      return {
        ...metadata,
        rpcUrl,
        rpcUrls,
        websocketRpcUrl,
        websocketRpcUrls,
        viemChain: defineChain({
          id: chain.id,
          name: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: { default: { http: rpcUrls, webSocket: websocketRpcUrls.length ? websocketRpcUrls : undefined } },
          blockExplorers: { default: { name: `${chain.name} Explorer`, url: chain.blockExplorerUrl } },
        }),
      };
    });
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(`Unable to load chain configuration from ${absolutePath}`, { cause: error });
  }
}
