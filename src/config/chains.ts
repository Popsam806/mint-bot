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
  websocketRpcUrl?: string;
  viemChain: Chain;
};

function resolveRpcUrl(environment: NodeJS.ProcessEnv, variableName: string, schema: z.ZodType<string>): string {
  const value = environment[variableName];
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new ConfigurationError(`Environment variable ${variableName} must contain a valid RPC URL`);
  }

  return result.data;
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
      const rpcUrl = resolveRpcUrl(environment, rpcUrlEnv, httpRpcUrlSchema);
      const websocketRpcUrl = websocketRpcUrlEnv
        ? resolveRpcUrl(environment, websocketRpcUrlEnv, websocketRpcUrlSchema)
        : undefined;

      return {
        ...metadata,
        rpcUrl,
        websocketRpcUrl,
        viemChain: defineChain({
          id: chain.id,
          name: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: { default: { http: [rpcUrl], webSocket: websocketRpcUrl ? [websocketRpcUrl] : undefined } },
          blockExplorers: { default: { name: `${chain.name} Explorer`, url: chain.blockExplorerUrl } },
        }),
      };
    });
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(`Unable to load chain configuration from ${absolutePath}`, { cause: error });
  }
}
