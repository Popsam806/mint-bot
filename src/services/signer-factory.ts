import type { Environment } from '../config/env.js';
import { DevelopmentSigner, HttpExternalSignerTransport, ProductionSignerAdapter, UnconfiguredSigner, type Signer } from './signer.js';

export interface ConfiguredSigner { signer: Signer; enabled: boolean; provider: 'none' | 'development' | 'external'; }

export function createConfiguredSigner(environment: Environment): ConfiguredSigner {
  const provider = environment.SIGNER_PROVIDER === 'none' && environment.DEVELOPMENT_PRIVATE_KEY ? 'development' : environment.SIGNER_PROVIDER;
  if (provider === 'development') {
    if (!environment.DEVELOPMENT_PRIVATE_KEY) return { signer: new UnconfiguredSigner(), enabled: false, provider };
    return { signer: new DevelopmentSigner(environment.DEVELOPMENT_PRIVATE_KEY as `0x${string}`, environment.NODE_ENV), enabled: true, provider };
  }
  if (provider === 'external') {
    if (!environment.SIGNER_ADDRESS || !environment.SIGNER_ENDPOINT) throw new Error('External signer configuration is incomplete');
    return { signer: new ProductionSignerAdapter(new HttpExternalSignerTransport(environment.SIGNER_ENDPOINT, environment.SIGNER_AUTH_TOKEN), environment.SIGNER_ADDRESS), enabled: true, provider };
  }
  return { signer: new UnconfiguredSigner(), enabled: false, provider: 'none' };
}
