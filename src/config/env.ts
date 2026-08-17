import 'dotenv/config';
import { z } from 'zod';
import { isAddress } from 'viem';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  CHAINS_CONFIG_PATH: z.string().min(1).default('./config/chains.json'),
  DEVELOPMENT_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  SIGNER_PROVIDER: z.enum(['none', 'development', 'external']).default('none'),
  SIGNER_ADDRESS: z.string().refine(isAddress, 'Signer address must be a valid EVM address').optional(),
  SIGNER_ENDPOINT: z.string().url().optional(),
  SIGNER_AUTH_TOKEN: z.string().min(1).optional(),
}).superRefine((value, context) => {
  if (value.NODE_ENV === 'production' && value.DEVELOPMENT_PRIVATE_KEY) context.addIssue({ code: z.ZodIssueCode.custom, path: ['DEVELOPMENT_PRIVATE_KEY'], message: 'Development signer is forbidden in production' });
  if (value.NODE_ENV === 'production' && value.SIGNER_PROVIDER === 'development') context.addIssue({ code: z.ZodIssueCode.custom, path: ['SIGNER_PROVIDER'], message: 'Development signer provider is forbidden in production' });
  if (value.SIGNER_PROVIDER === 'development' && !value.DEVELOPMENT_PRIVATE_KEY) context.addIssue({ code: z.ZodIssueCode.custom, path: ['DEVELOPMENT_PRIVATE_KEY'], message: 'Development signer provider requires DEVELOPMENT_PRIVATE_KEY' });
  if (value.SIGNER_PROVIDER === 'external' && !value.SIGNER_ADDRESS) context.addIssue({ code: z.ZodIssueCode.custom, path: ['SIGNER_ADDRESS'], message: 'External signer provider requires SIGNER_ADDRESS' });
  if (value.SIGNER_PROVIDER === 'external' && !value.SIGNER_ENDPOINT) context.addIssue({ code: z.ZodIssueCode.custom, path: ['SIGNER_ENDPOINT'], message: 'External signer provider requires SIGNER_ENDPOINT' });
});

export function parseEnvironment(environment: NodeJS.ProcessEnv) {
  const result = envSchema.safeParse(environment);

  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return result.data;
}

export const env = parseEnvironment(process.env);
export type Environment = typeof env;
