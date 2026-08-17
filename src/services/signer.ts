import { isAddress, parseTransaction, recoverTransactionAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export interface UnsignedTransaction {
  chainId: number; to: `0x${string}`; data: `0x${string}`; value: bigint; gas: bigint; nonce: number;
  maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint;
}
export interface Signer {
  getAddress(): Promise<string>;
  signTransaction(transaction: UnsignedTransaction): Promise<string>;
}

export interface ExternalSignerTransport {
  getAddress(): Promise<string>;
  signTransaction(transaction: UnsignedTransaction): Promise<string>;
}

async function validateSerializedTransaction(serialized: string, expected: UnsignedTransaction, expectedAddress: string): Promise<string> {
  if (typeof serialized !== 'string' || !/^0x[0-9a-fA-F]+$/.test(serialized) || serialized.length % 2 !== 0) throw new Error('External signer returned a malformed signed transaction');
  try {
    const parsed = parseTransaction(serialized as `0x${string}`);
    if (!parsed.r || !parsed.s) throw new Error('missing signature');
    if (parsed.chainId !== expected.chainId || parsed.to?.toLowerCase() !== expected.to.toLowerCase() || parsed.data !== expected.data
      || parsed.value !== expected.value || parsed.gas !== expected.gas || parsed.nonce !== expected.nonce
      || parsed.gasPrice !== expected.gasPrice || parsed.maxFeePerGas !== expected.maxFeePerGas || parsed.maxPriorityFeePerGas !== expected.maxPriorityFeePerGas) {
      throw new Error('signed transaction does not match request');
    }
    const recovered = await recoverTransactionAddress({ serializedTransaction: serialized as never });
    if (recovered.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error('signed transaction was produced by an unexpected address');
  } catch (error) {
    throw new Error(`External signer returned a malformed signed transaction: ${error instanceof Error ? error.message : 'invalid RLP'}`);
  }
  return serialized;
}

export class DevelopmentSigner implements Signer {
  private readonly account;
  constructor(privateKey: `0x${string}`, environment: string) {
    if (!['development', 'test'].includes(environment)) throw new Error('DevelopmentSigner is disabled outside development and test');
    this.account = privateKeyToAccount(privateKey);
  }
  async getAddress(): Promise<string> { return this.account.address.toLowerCase(); }
  signTransaction(transaction: UnsignedTransaction): Promise<string> {
    const base = { chainId: transaction.chainId, to: transaction.to, data: transaction.data, value: transaction.value, gas: transaction.gas, nonce: transaction.nonce };
    return transaction.gasPrice !== undefined
      ? this.account.signTransaction({ ...base, gasPrice: transaction.gasPrice, type: 'legacy' })
      : this.account.signTransaction({ ...base, maxFeePerGas: transaction.maxFeePerGas!, maxPriorityFeePerGas: transaction.maxPriorityFeePerGas!, type: 'eip1559' });
  }
}

export class ProductionSignerAdapter implements Signer {
  constructor(private readonly transport: ExternalSignerTransport, private readonly configuredAddress: string) {
    if (!isAddress(configuredAddress)) throw new Error('Production signer address is invalid');
  }
  async getAddress(): Promise<string> {
    const address = await this.transport.getAddress();
    if (!isAddress(address) || address.toLowerCase() !== this.configuredAddress.toLowerCase()) throw new Error('Production signer address does not match configured signer address');
    return address.toLowerCase();
  }
  async signTransaction(transaction: UnsignedTransaction): Promise<string> {
    await this.getAddress();
    return validateSerializedTransaction(await this.transport.signTransaction(transaction), transaction, this.configuredAddress);
  }
}

export class HttpExternalSignerTransport implements ExternalSignerTransport {
  constructor(private readonly endpoint: string, private readonly authToken?: string, private readonly fetcher: typeof fetch = fetch) {}
  async getAddress(): Promise<string> {
    const response = await this.fetcher(`${this.endpoint}/address`, { headers: this.headers() });
    if (!response.ok) throw new Error(`External signer address request failed with status ${response.status}`);
    const body = await response.json() as { address?: unknown };
    if (typeof body.address !== 'string') throw new Error('External signer address response is malformed');
    return body.address;
  }
  async signTransaction(transaction: UnsignedTransaction): Promise<string> {
    const response = await this.fetcher(`${this.endpoint}/sign`, { method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' }, body: JSON.stringify(transaction, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value) });
    if (!response.ok) throw new Error(`External signer signing request failed with status ${response.status}`);
    const body = await response.json() as { signedTransaction?: unknown };
    if (typeof body.signedTransaction !== 'string') throw new Error('External signer signing response is malformed');
    return body.signedTransaction;
  }
  private headers(): Record<string, string> { return this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}; }
}

export class UnconfiguredSigner implements Signer {
  async getAddress(): Promise<string> { throw new Error('Signer is not configured'); }
  async signTransaction(): Promise<string> { throw new Error('Signer is not configured'); }
}
