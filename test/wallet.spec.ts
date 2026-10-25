import { InMemoryWalletStore } from '../src/wallet/in-memory-wallet.store';
import { WalletService } from '../src/wallet/wallet.service';

// stub QueueService: cukup registerWorker/enqueue no-op (settlement langsung via callback tak dibutuhkan di test)
const stubQueue = () => ({
  registerWorker: (_q: string, _h: (...a: unknown[]) => unknown) => void _q,
  enqueue: async (q: string, payload: Record<string, unknown>) => ({ queue: q, payload, createdAt: new Date().toISOString() }),
}) as never;

const setup = async () => {
  const store = new InMemoryWalletStore();
  const service = new WalletService(store, stubQueue());
  await service.topupBki('acc-a', 100_000, 'seed-topup-1');
  return { store, service };
};

describe('Wallet: idempotency transfer internal (double submit)', () => {
  it('transfer double-submit dengan idempotency key sama -> tepat 1 set ledger entry', async () => {
    const { store, service } = await setup();
    const key = 'transfer-key-1';
    const r1 = await service.transferInternal('acc-a', 'acc-b', 10_000, key);
    const r2 = await service.transferInternal('acc-a', 'acc-b', 10_000, key); // double submit

    expect(r1.data.created).toBe(true);
    expect(r2.data.created).toBe(false);
    expect(r1.data.transactionId).toBe(r2.data.transactionId);

    const debitEntries = store.entries.filter((e) => e.accountId && e.direction === 'DEBIT' && e.amount === 10_000);
    expect(debitEntries.length).toBe(1); // tepat satu ledger entry debit
    expect(await service.balance('acc-a')).toBe(90_000);
    expect(await service.balance('acc-b')).toBe(10_000);
    expect(r2.message).toContain('idempoten');
  });

  it('key berbeda tetap dieksekusi normal', async () => {
    const { store, service } = await setup();
    await service.transferInternal('acc-a', 'acc-b', 5_000, 'k1');
    await service.transferInternal('acc-a', 'acc-b', 5_000, 'k2');
    expect(store.entries.filter((e) => e.direction === 'DEBIT' && e.amount === 5_000).length).toBe(2);
    expect(await service.balance('acc-b')).toBe(10_000);
  });
});

describe('Wallet: saldo tidak pernah negatif saat debit paralel', () => {
  it('50 debit paralel 1.000 pada saldo 20.000 -> tepat 20 sukses, saldo akhir >= 0', async () => {
    const { store, service } = await setup();
    await service.topupBki('acc-c', 20_000, 'seed-c');
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) => service.transferInternal('acc-c', 'acc-b', 1_000, `par-${i}`)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;
    const balance = await service.balance('acc-c');
    expect(ok).toBe(20);
    expect(failed).toBe(30);
    expect(balance).toBe(0); // tidak pernah negatif
    expect(await service.balance('acc-b')).toBe(20_000); // 20 transfer sukses
    // sanity: jumlah transaksi tidak lebih dari yang seharusnya
    expect(store.transactions.size).toBe(22); // 20 transfer + 2 topup
  });

  it('debit paralel dengan saldo besar -> semuanya sukses, saldo 0', async () => {
    const { service } = await setup();
    await service.topupBki('acc-d', 50_000, 'seed-d');
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) => service.transferInternal('acc-d', 'acc-b', 1_000, `par2-${i}`)),
    );
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(50);
    expect(await service.balance('acc-d')).toBe(0);
  });
});
