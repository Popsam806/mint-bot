import { describe, expect, it, vi } from 'vitest';
import { SourceTransactionReconciliationService } from '../../src/services/source-transaction-reconciliation-service.js';

describe('SourceTransactionReconciliationService', () => {
  it('marks a previously mined source reorged when it disappears', async () => {
    const transactions = { listMinedForReconciliation: vi.fn(async () => [{ transactionHash: '0x1', externalChainId: 1 }]), markReorged: vi.fn(async () => undefined), markMined: vi.fn() };
    const service = new SourceTransactionReconciliationService(transactions as never, () => ({ getReceipt: vi.fn(async () => null) }) as never, { warn: vi.fn() } as never);
    await service.reconcileNow(); expect(transactions.markReorged).toHaveBeenCalledWith('0x1');
  });
  it('does not mutate source state on a temporary RPC failure', async () => {
    const transactions = { listMinedForReconciliation: vi.fn(async () => [{ transactionHash: '0x1', externalChainId: 1 }]), markReorged: vi.fn(), markMined: vi.fn() };
    const service = new SourceTransactionReconciliationService(transactions as never, () => ({ getReceipt: vi.fn(async () => { throw new Error('timeout'); }) }) as never, { warn: vi.fn() } as never);
    await service.reconcileNow(); expect(transactions.markReorged).not.toHaveBeenCalled();
  });
});
