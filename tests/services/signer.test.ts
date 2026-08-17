import { describe, expect, it, vi } from 'vitest';
import { parseEnvironment } from '../../src/config/env.js';
import { createConfiguredSigner } from '../../src/services/signer-factory.js';
import { DevelopmentSigner, HttpExternalSignerTransport, ProductionSignerAdapter, type UnsignedTransaction } from '../../src/services/signer.js';

const privateKey = `0x${'1'.repeat(64)}` as `0x${string}`;
const destination = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';
const transaction: UnsignedTransaction = {
  chainId: 1,
  to: '0x0000000000000000000000000000000000000033',
  data: '0x1234',
  value: 1n,
  gas: 100000n,
  nonce: 1,
  maxFeePerGas: 3n,
  maxPriorityFeePerGas: 1n,
};

const baseEnvironment = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://localhost/test',
  REDIS_URL: 'redis://localhost:6379',
  SIGNER_PROVIDER: 'external',
  SIGNER_ADDRESS: destination,
  SIGNER_ENDPOINT: 'https://signer.example.test',
} as const;

describe('production signer configuration', () => {
  it('initializes an external production signer', () => {
    const configured = createConfiguredSigner(parseEnvironment(baseEnvironment));
    expect(configured).toMatchObject({ enabled: true, provider: 'external' });
    expect(configured.signer).toBeInstanceOf(ProductionSignerAdapter);
  });

  it('fails closed when external signer configuration is missing', () => {
    expect(() => parseEnvironment({ ...baseEnvironment, SIGNER_ENDPOINT: undefined })).toThrow('SIGNER_ENDPOINT');
    expect(() => parseEnvironment({ ...baseEnvironment, SIGNER_ADDRESS: undefined })).toThrow('SIGNER_ADDRESS');
  });

  it('fails closed when no signer provider is configured', async () => {
    const configured = createConfiguredSigner(parseEnvironment({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://localhost/test', REDIS_URL: 'redis://localhost:6379' }));
    expect(configured.enabled).toBe(false);
    await expect(configured.signer.getAddress()).rejects.toThrow('Signer is not configured');
  });

  it('rejects development private material and provider in production', () => {
    expect(() => parseEnvironment({ ...baseEnvironment, DEVELOPMENT_PRIVATE_KEY: privateKey })).toThrow('Development signer is forbidden in production');
    expect(() => parseEnvironment({ ...baseEnvironment, SIGNER_PROVIDER: 'development', DEVELOPMENT_PRIVATE_KEY: privateKey })).toThrow('forbidden in production');
  });
});

describe('ProductionSignerAdapter', () => {
  it('retrieves and normalizes the verified signer address', async () => {
    const signer = new ProductionSignerAdapter({ getAddress: vi.fn(async () => destination), signTransaction: vi.fn() }, destination);
    await expect(signer.getAddress()).resolves.toBe(destination.toLowerCase());
  });

  it('signs successfully through a mocked external signer', async () => {
    const signed = await new DevelopmentSigner(privateKey, 'test').signTransaction(transaction);
    const transport = { getAddress: vi.fn(async () => destination), signTransaction: vi.fn(async () => signed) };
    const signer = new ProductionSignerAdapter(transport, destination);
    await expect(signer.signTransaction(transaction)).resolves.toBe(signed);
    expect(transport.signTransaction).toHaveBeenCalledWith(transaction);
  });

  it('fails closed on address mismatch before signing', async () => {
    const transport = { getAddress: vi.fn(async () => transaction.to), signTransaction: vi.fn() };
    const signer = new ProductionSignerAdapter(transport, destination);
    await expect(signer.signTransaction(transaction)).rejects.toThrow('does not match');
    expect(transport.signTransaction).not.toHaveBeenCalled();
  });

  it('fails closed when external signing fails', async () => {
    const signer = new ProductionSignerAdapter({ getAddress: vi.fn(async () => destination), signTransaction: vi.fn(async () => { throw new Error('custody unavailable'); }) }, destination);
    await expect(signer.signTransaction(transaction)).rejects.toThrow('custody unavailable');
  });

  it('rejects a valid signature over a different transaction', async () => {
    const signed = await new DevelopmentSigner(privateKey, 'test').signTransaction({ ...transaction, nonce: 2 });
    const signer = new ProductionSignerAdapter({ getAddress: vi.fn(async () => destination), signTransaction: vi.fn(async () => signed) }, destination);
    await expect(signer.signTransaction(transaction)).rejects.toThrow('does not match request');
  });

  it.each(['not-hex', '0x1234', '0x01'])('fails closed on malformed signed transaction %s', async (signedTransaction) => {
    const signer = new ProductionSignerAdapter({ getAddress: vi.fn(async () => destination), signTransaction: vi.fn(async () => signedTransaction) }, destination);
    await expect(signer.signTransaction(transaction)).rejects.toThrow('malformed signed transaction');
  });

  it('keeps the auth token confined to the external request header', async () => {
    const token = 'sensitive-auth-token';
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ address: destination }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const transport = new HttpExternalSignerTransport('https://signer.example.test', token, fetcher as never);
    await transport.getAddress();
    expect(fetcher).toHaveBeenCalledWith('https://signer.example.test/address', { headers: { authorization: `Bearer ${token}` } });
    expect(JSON.stringify(transaction, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)).not.toContain(token);
  });
});
