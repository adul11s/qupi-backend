import { InMemoryWalletStore } from '../src/wallet/in-memory-wallet.store';
import { WalletService } from '../src/wallet/wallet.service';

const TOPUP_KEY = 'seed-topup-1';

const setup = async () => {
  const store = new InMemoryWalletStore();
  const service = new WalletService(store);
  await service.topup('acc-a', 100_000, TOPUP_KEY);
  return { store, service };
};

describe('Wallet: idempotency', () => {
  it('transfer double-submit dengan idempotency key sama -> tepat 1 set ledger entry', async () => {
    const { store, service } = await setup();
    const key = 'transfer-key-1';
    const r1 = await service.transfer('acc-a', 'acc-b', 10_000, key);
    const r2 = await service.transfer('acc-a', 'acc-b', 10_000, key); // double submit

    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r1.transactionId).toBe(r2.transactionId);

    const debitEntries = store.entries.filter((e) => e.accountId === 'acc-a' && e.direction === 'DEBIT');
    expect(debitEntries.length).toBe(1); // tepat satu ledger entry debit
    expect((await service.balance('acc-a'))).toBe(90_000);
    expect((await service.balance('acc-b'))).toBe(10_000);
  });

  it('key berbeda tetap dieksekusi normal', async () => {
    const { store, service } = await setup();
    await service.transfer('acc-a', 'acc-b', 5_000, 'k1');
    await service.transfer('acc-a', 'acc-b', 5_000, 'k2');
    expect(store.entries.filter((e) => e.direction === 'DEBIT').length).toBe(2);
    expect((await service.balance('acc-b'))).toBe(10_000);
  });
});

describe('Wallet: saldo tidak pernah negatif saat debit paralel', () => {
  it('50 debit paralel kontan 1.000 pada saldo 20.000 -> tepat 20 sukses, saldo akhir >= 0', async () => {
    const { store, service } = await setup();
    await service.topup('acc-c', 20_000, 'seed-c');
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) => service.transfer('acc-c', 'acc-b', 1_000, `par-${i}`)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;
    const balance = await service.balance('acc-c');
    expect(ok).toBe(20);
    expect(failed).toBe(30);
    expect(balance).toBe(0); // tidak pernah negatif
    expect(await service.balance('acc-b')).toBe(20_000); // 20 transfer sukses
    // sanity: jumlah ledger tidak lebih dari yang seharusnya
    expect(store.transactions.size).toBe(20 + 2); // 20 transfer + 2 topup seed
  });

  it('debit paralel dengan saldo besar -> semuanya sukses, saldo 0', async () => {
    const { service } = await setup();
    await service.topup('acc-d', 50_000, 'seed-d');
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) => service.transfer('acc-d', 'acc-b', 1_000, `par2-${i}`)),
    );
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(50);
    expect(await service.balance('acc-d')).toBe(0);
  });
});
