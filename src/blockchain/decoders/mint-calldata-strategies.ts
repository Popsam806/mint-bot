import { decodeFunctionData, encodeFunctionData, parseAbi, toFunctionSelector, type Hex } from 'viem';
import type { MintStrategy } from '../../database/types.js';

const publicDefinitions = [
  { signature: 'mint(uint256)', abi: parseAbi(['function mint(uint256 quantity) payable']), recipient: null },
  { signature: 'publicMint(uint256)', abi: parseAbi(['function publicMint(uint256 quantity) payable']), recipient: null },
  { signature: 'mint(address,uint256)', abi: parseAbi(['function mint(address recipient,uint256 quantity) payable']), recipient: 0 },
  { signature: 'publicMint(address,uint256)', abi: parseAbi(['function publicMint(address recipient,uint256 quantity) payable']), recipient: 0 },
  { signature: 'mint(address)', abi: parseAbi(['function mint(address recipient) payable']), recipient: 0 },
] as const;

const merkleSelectors = new Set(['allowlistMint(uint256,bytes32[])', 'mint(uint256,bytes32[])', 'mint(address,uint256,bytes32[])'].map(toFunctionSelector));
const signatureSelectors = new Set(['mint(uint256,bytes)', 'mint(address,uint256,bytes)', 'authorizedMint(address,uint256,bytes)'].map(toFunctionSelector));

export interface StrategyAnalysis { strategy: MintStrategy; calldata: Hex | null; functionSelector: string; functionName: string | null; quantity: bigint | null; recipientReplaced: boolean; supported: boolean; explanation: string; }

export function analyzeMintCalldata(input: Hex, sourceWallet: string, destinationWallet: string): StrategyAnalysis {
  const selector = input.slice(0, 10).toLowerCase();
  if (merkleSelectors.has(selector as Hex)) return { strategy: 'MERKLE_ALLOWLIST', calldata: null, functionSelector: selector, functionName: null, quantity: null, recipientReplaced: false, supported: false, explanation: 'Calldata contains a Merkle proof. Destination-wallet eligibility and a fresh proof are required.' };
  if (signatureSelectors.has(selector as Hex)) return { strategy: 'SIGNATURE_AUTHORIZED', calldata: null, functionSelector: selector, functionName: null, quantity: null, recipientReplaced: false, supported: false, explanation: 'Calldata contains signature authorization that cannot be reused for another wallet.' };
  for (const definition of publicDefinitions) {
    if (toFunctionSelector(definition.signature) !== selector) continue;
    const decoded = decodeFunctionData({ abi: definition.abi, data: input });
    const args = [...(decoded.args ?? [])];
    let recipientReplaced = false;
    if (definition.recipient !== null) {
      const originalRecipient = String(args[definition.recipient]).toLowerCase();
      if (originalRecipient !== sourceWallet.toLowerCase()) return { strategy: 'UNKNOWN', calldata: null, functionSelector: selector, functionName: decoded.functionName, quantity: null, recipientReplaced: false, supported: false, explanation: 'The recipient parameter is not the monitored source wallet, so replacing it would be unsafe.' };
      args[definition.recipient] = destinationWallet as `0x${string}`; recipientReplaced = true;
    }
    const quantityValue = definition.recipient === null ? args[0] : args[1];
    return { strategy: 'PUBLIC_MINT', calldata: encodeFunctionData({ abi: definition.abi, functionName: decoded.functionName, args: args as never }), functionSelector: selector, functionName: decoded.functionName, quantity: typeof quantityValue === 'bigint' ? quantityValue : 1n, recipientReplaced, supported: true, explanation: recipientReplaced ? 'Recognized public mint calldata and replaced the explicit source recipient.' : 'Recognized public mint calldata using the transaction sender as recipient.' };
  }
  return { strategy: 'UNKNOWN', calldata: null, functionSelector: selector, functionName: null, quantity: null, recipientReplaced: false, supported: false, explanation: 'The mint calldata shape is not explicitly supported; no transaction was guessed.' };
}
