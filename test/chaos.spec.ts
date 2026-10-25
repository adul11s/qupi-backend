import { InMemoryWalletStore } from '../src/wallet/in-memory-wallet.store';
import { WalletService } from '../src/wallet/wallet.service';
import { OutboxService } from '../src/outbox/outbox.service';
import { InMemoryOutboxStore } from '../src/outbox/in-memory-outbox.store';
import { InMemoryAuditStore } from '../src/audit/in-memory-audit.store';
import { AuditService } from '../src/audit/audit.service';

// Stub QueueService (mode queue legacy) — settlement via outbox saat tersedia.
const stubQueue = () =>
  ({
    registerWorker: (_q: string, _h: (...a: unknown[]) => unknown) => void _q,
    enqueue: async (q: string) => ({ queue: q, createdAt: new Date().toISOString() }),
  }) as never;

// Chaos 1 — provider timeout mid-tx: BKI "timeout", topup PENDING,
// saldo BELUM naik; sesudah callback/provider SUCCESS, saldo masuk.
describe('Chaos: provider timeout mid-tx (BKI_MODE=timeout)', () => {
  const OLD = process.env.BKI_MODE;
  beforeEach(() => {
    process.env.BKI_MODE = 'timeout';
  });
  afterEach(() => {
    process.env.BKI_MODE = OLD;
  });

  it('topup PENDING saat timeout; callback SUCCESS menyudahkan (saldo hanya satu kali)', async () => {
    const store = new InMemoryWalletStore();
    const outbox = new OutboxService(new InMemoryOutboxStore());
    const svc = new WalletService(store, stubQueue(), undefined, undefined, outbox);
    outbox.registerHandler('settlement', async (payload) => {
      await svc.settleFromQueue(payload as { transactionId: string; debits?: { accountId: string; amount: number }[]; credits?: string[] });
    });

    const res = await svc.topupBki('acc-a', 250_000, 'chaos-topup-1');
    expect(res.message).toContain('PENDING');
    expect(await svc.balance('acc-a')).toBe(0); // saldo belum naik saat provider menggantung

    // webhook sandbox: provider akhirnya sukses
    await svc.topupCallback((res.data as unknown as { id: string }).id, 'SUCCESS');
    expect(await svc.balance('acc-a')).toBe(250_000);
  });
});

// Chaos 2 — webhook ganda: HMAC sudah diverifikasi di controller; di sini
// handler wallet diuji double-delivery: callback SUCCESS 2x — saldo tepat sekali.
describe('Chaos: webhook ganda (double delivery)', () => {
  it('callback SUCCESS dua kali sebelum settle? saldo masuk tepat satu kali', async () => {
    const store = new InMemoryWalletStore();
    const svc = new WalletService(store, stubQueue());
    const _t1 = await svc.topupBki('acc-a', 100_000, 'chaos-topup-2'); // BKI success
    const t2 = await svc.topupBki('acc-b', 200_000, 'chaos-topup-3');
    const tid = (t2.data as unknown as { id: string }).id;
    // callback kedua datang telat (sudah SUCCESS) — settle ulang harus replay
    const first = await svc.topupCallback(tid, 'SUCCESS');
    const second = await svc.topupCallback(tid, 'SUCCESS');
    expect(first.message).toContain('disettle');
    expect(second.message).toContain('disettle');
    expect(await svc.balance('acc-b')).toBe(200_000); // tidak dobel kredit
  });

  it('double-delivery topup via webhook FAILED lalu SUCCESS: saldo tetap benar', async () => {
    const store = new InMemoryWalletStore();
    const svc = new WalletService(store, stubQueue());
    const t3 = await svc.topupBki('acc-c', 50_000, 'chaos-topup-4');
    const tidC = (t3.data as unknown as { id: string }).id;
    // SUCCESS dulu, FAILED telat datang (retry provider aneh) — tidak boleh incident debit
    const cb1 = await svc.topupCallback(tidC, 'SUCCESS');
    const cb2 = await svc.topupCallback(tidC, 'FAILED'); // webhook ganda dengan status beda
    expect(await svc.balance('acc-c')).toBe(50_000); // FAILED telat tidak mengubah ledger (replay SUCCESS)
    void cb1; void cb2;

    // refund admin idempotent utk reversal yang benar: dua kali refund sama key
    const r1 = await svc.refundTopup(tidC, 'admin-1');
    const r2 = await svc.refundTopup(tidC, 'admin-1');
    expect(r2.message).toContain('idempoten');
    expect(await svc.balance('acc-c')).toBe(0);
    void r1;
  });
});

// Chaos 3 — crash mid-settlement: event outbox dikommit (dengan pledge),
// proses MATI sebelum drain; process ini menimulasi restart, drain tetap
// satu jalan dan berekonsiliasi.
describe('Chaos: crash proses mid-settlement (restart + drain outbox)', () => {
  it('settlement event PENDING terselamatkan saat proses restart dan diproses tepat sekali', async () => {
    const store = new InMemoryWalletStore();
    const outboxStore = new InMemoryOutboxStore();
    const svc = new WalletService(store, stubQueue(), undefined, undefined, new OutboxService(outboxStore));
    await svc.topupBki('acc-d', 100_000, 'chaos-topup-5'); // seed saldo (BKI success)
    expect(await svc.balance('acc-d')).toBe(100_000);

    // transfer bank lewat jalur outbox (pledge + event dalam satu atomic batch),
    // setImmediate drain TIDAK panggil kesini (simulasi crash):
    const res = await svc.transferBank('acc-d', 75_000, 'chaos-bank-1', { bankCode: 'BCA', accountNumber: '001234' });
    expect(res.message).toContain('PENDING');
    expect(await svc.balance('acc-d')).toBe(100_000); // debit belum tercatat saat crash
    expect((await new OutboxService(outboxStore).pending('settlement')).length).toBe(1);

    // restart proses baru pada store sama - handler sama seperti WorkerModule
    const svc2 = new WalletService(store, stubQueue(), undefined, undefined, new OutboxService(outboxStore));
    const outbox2 = new OutboxService(outboxStore);
    outbox2.registerHandler('settlement', async (payload) => {
      await svc2.settleFromQueue(payload as { transactionId: string; debits?: { accountId: string; amount: number }[]; credits?: string[] });
    });
    const r = await outbox2.process('settlement');
    expect(r).toEqual({ processed: 1, failed: 0 });
    expect(await svc2.balance('acc-d')).toBe(25_000); // debit 75k terekam tepat sekali
    // drain berikutnya: idempotent
    expect((await outbox2.process('settlement')).processed).toBe(0);
  });
});

// Chaos 4 — audit terselamatkan dari restart (store append ke bucket sama)
describe('Chaos: audit log append-only', () => {
  it('record berturut-turut tidak menimpa baris (append-only)', async () => {
    const store = new InMemoryAuditStore();
    const audit = new AuditService(store);
    await audit.record({ actorId: 'a', actorRole: 'ADMIN', action: 'REFUND', targetType: 'TRANSACTION', targetId: 't1' });
    await audit.record({ actorId: 'a', actorRole: 'ADMIN', action: 'REFUND', targetType: 'TRANSACTION', targetId: 't1' });
    expect(store.rows).toHaveLength(2);
    expect(store.rows.every((r) => r.action === 'REFUND')).toBe(true);
  });
});
