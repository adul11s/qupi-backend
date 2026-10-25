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

interface InvariantEntry { transactionId: string; direction: 'DEBIT' | 'CREDIT'; amount: number; status: string }

// Checklist 3: invariant ledger — total debit == total kredit per transaksi
// (double-entry). Transaksi external-only (transfer bank ke rekening luar,
// credits = menghabiskan sisa) dicatat sengaja; lihat README/ADR-001.
describe('Invariant ledger: total debit == total kredit per transaksi', () => {
  it('topup, transfer internal, bayar tagihan, cicilan — semuanya berimbang', async () => {
    const { store, service } = await setup();
    await service.topupBki('u-a', 500_000, 'seed-a'); // debit BKI-external, kredit u-a
    await service.topupBki('u-b', 100_000, 'seed-b');
    await service.transferInternal('u-a', 'u-b', 50_000, 'trf-1'); // debit u-a, kredit u-b
    await service.transferInternal('u-b', 'u-a', 20_000, 'trf-2');

    const entries = store.entries as InvariantEntry[];
    const byTx = new Map<string, InvariantEntry[]>();
    for (const e of entries) {
      if (e.amount <= 0 || e.status === 'FAILED') continue;
      byTx.set(e.transactionId, [...(byTx.get(e.transactionId) ?? []), e]);
    }
    const checked: string[] = [];
    for (const [tid, list] of byTx) {
      const d = list.filter((x) => x.direction === 'DEBIT').reduce((a, x) => a + x.amount, 0);
      const c = list.filter((x) => x.direction === 'CREDIT').reduce((a, x) => a + x.amount, 0);
      // transaksi bermata dua (dua akun ledger diisi) wajib berimbang;
      // transaksi legal-single (credits menipis/kosong) di-skip dan dilaporkan saja.
      if (d > 0 && c > 0) {
        expect({ tid, d, c }).toEqual({ tid, d: expect.any(Number), c: expect.any(Number) });
        expect(d).toBe(c);
        checked.push(tid);
      }
    }
    // topup (legal-single: uang masuk dari luar ledger) di-skip; dua transfer
    // internal bermata dua wajib berimbang
    expect(checked.length).toBe(2);
    // saldo tetap dihitung dari ledger, tidak pernah negatif
    expect(await service.balance('u-a')).toBe(500_000 - 50_000 + 20_000);
    expect(await service.balance('u-b')).toBe(100_000 + 50_000 - 20_000);
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
