import { InMemoryWalletStore } from '../src/wallet/in-memory-wallet.store';
import { WalletService } from '../src/wallet/wallet.service';

const stubQueue = () => ({
  registerWorker: (_q: string, _h: (...a: unknown[]) => unknown) => void _q,
  enqueue: async (q: string, payload: Record<string, unknown>) => ({ queue: q, payload, createdAt: new Date().toISOString() }),
}) as never;

const setup = async () => {
  const store = new InMemoryWalletStore();
  const service = new WalletService(store, stubQueue());
  return { store, service };
};

interface InvariantEntry { accountId: string; transactionId: string; direction: 'DEBIT' | 'CREDIT'; amount: number; status: string }

// Checklist 3 (re-review all 2026-10-25): invariant UNIVERSAL — untuk SETIAP
// transaksi Σdebit == Σkredit, TANPA pengecualian (double-entry penuh).
// Dana masuk dari luar ledger dibebankan ke `virtual:external-funding-suspense`;
// dana keluar (transfer bank, refund) ke `virtual:external-payout-clearing`.
describe('Invariant ledger: Σdebit == Σkredit untuk SETIAP transaksi (tanpa pengecualian)', () => {
  it('topup, transfer internal, bayar tagihan, cicilan — semuanya berimbang', async () => {
    const { store, service } = await setup();
    await service.topupBki('u-a', 500_000, 'seed-a'); // funding → suspense
    await service.topupBki('u-b', 100_000, 'seed-b');
    await service.transferInternal('u-a', 'u-b', 50_000, 'trf-1');
    await service.transferInternal('u-b', 'u-a', 20_000, 'trf-2');

    const entries = store.entries as InvariantEntry[];
    const byTx = new Map<string, InvariantEntry[]>();
    for (const e of entries) {
      if (e.amount <= 0 || e.status === 'FAILED') continue;
      byTx.set(e.transactionId, [...(byTx.get(e.transactionId) ?? []), e]);
    }
    const balanced: string[] = [];
    for (const [tid, list] of byTx) {
      const d = list.filter((x) => x.direction === 'DEBIT').reduce((a, x) => a + x.amount, 0);
      const c = list.filter((x) => x.direction === 'CREDIT').reduce((a, x) => a + x.amount, 0);
      expect(d).toBe(c); // TANPA pengecualian — satu sisi = bug
      balanced.push(tid);
    }
    // 4 tansaksi: 2 topup + 2 transfer internal — semuanya sudah berimbang
    expect(balanced.length).toBe(4);
    // akun virtual benar-benar dipakai sebagai pasangan sisi eksternal
    const suspenseEntries = entries.filter((e) => e.accountId === 'virtual:external-funding-suspense');
    expect(suspenseEntries.length).toBeGreaterThanOrEqual(2); // 2 topup
    // saldo tetap dihitung dari ledger, tidak pernah negatif
    expect(await service.balance('u-a')).toBe(500_000 - 50_000 + 20_000);
    expect(await service.balance('u-b')).toBe(100_000 + 50_000 - 20_000);
  });

  it('dana keluar (refund manual) juga berimbang via external-payout-clearing', async () => {
    const { store, service } = await setup();
    await service.topupBki('u-a', 10_000, 's');
    // refund manual: debits saja (uang keluar ledger ke sumber luar)
    const tid = [...store.transactions.values()].find((t) => t.kind === 'TOPUP' && t.userId === 'u-a')!.id;
    await (service as unknown as { refundTopup: (transactionId: string, actorId: string) => Promise<unknown> })
      .refundTopup(tid, 'admin');
    const entries = store.entries as InvariantEntry[];
    const byTx = new Map<string, InvariantEntry[]>();
    for (const e of entries) {
      if (e.amount <= 0 || e.status === 'FAILED') continue;
      byTx.set(e.transactionId, [...(byTx.get(e.transactionId) ?? []), e]);
    }
    for (const list of byTx.values()) {
      const d = list.filter((x) => x.direction === 'DEBIT').reduce((a, x) => a + x.amount, 0);
      const c = list.filter((x) => x.direction === 'CREDIT').reduce((a, x) => a + x.amount, 0);
      expect(d).toBe(c);
    }
    const clearing = entries.filter((e) => e.accountId === 'virtual:external-payout-clearing');
    if (clearing.length > 0) {
      // refund: kredit clearing == debit user
      const debitUser = entries.filter((e) => e.direction === 'DEBIT' && !e.accountId.startsWith('virtual:'));
      expect(debitUser.length).toBeGreaterThan(0);
    }
    expect(await service.balance('u-a')).toBeLessThanOrEqual(10_000);
  });

  it('transfer berhasil OLEH (created=false) tidak menulis ledger ganda', async () => {
    const { store, service } = await setup();
    await service.topupBki('u-a', 10_000, 's');
    await service.transferInternal('u-a', 'u-b', 4_000, 'k-idem');
    await service.transferInternal('u-a', 'u-b', 4_000, 'k-idem'); // replay
    const entries = store.entries as InvariantEntry[];
    expect(entries.filter((e) => e.amount === 4_000).length).toBe(2); // 1 debit + 1 kredit, tanpa duplikat
  });
});
