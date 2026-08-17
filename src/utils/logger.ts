import pino from 'pino';
import type { Environment } from '../config/env.js';

export function createLogger(environment: Environment): pino.Logger {
  return pino({ level: environment.LOG_LEVEL, base: { service: 'evm-copy-mint-bot' } });
}
