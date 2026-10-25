import { InMemoryWalletStore } from '../src/wallet/in-memory-wallet.store';
import { WalletService } from '../src/wallet/wallet.service';
import { PinService } from '../src/common/pin.service';
import { hashSecret } from '../src/common/hash.util';
// DomainError dihapus dari import (tidak terpakai)

// Checklist 3: unit test in-memory tetap jalan di mana-mana (tanpa Docker);
// test dengan Postgres ASLI (race + P2002 + FOR UPDATE + alur e2e IDOR/DTI/
// settlement) ada di test/e2e.pg.spec.ts — dijalankan di CI (service Postgres 16)
// dengan env RUN_PG_TESTS=1, dan bisa juga di lokal bila Postgres hidup.

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

describe('Fase-3: binding idempotensi ke payload (fingerprint)', () => {
  it('key SAMA tapi amount BEDA → IDEM_CONFLICT 409, saldo tetap benar', async () => {
    const { service } = await setup();
    const r1 = await service.topupBki('acc-a', 100_000, 'key-topup-1');
    expect(r1.message).toContain('berhasil');
    await expect(service.topupBki('acc-a', 200_000, 'key-topup-1')).rejects.toMatchObject({ code: 'IDEM_CONFLICT' });
    // transfer antar-niat dengan key yang sama juga ditolak
    await expect(service.transferInternal('acc-a', 'acc-b', 10_000, 'key-topup-1')).rejects.toMatchObject({ code: 'IDEM_CONFLICT' });
    expect(await service.balance('acc-a')).toBe(200_000);
  });

  it('key sama + payload identik → replay sah (created=false)', async () => {
    const { service } = await setup();
    await service.transferInternal('acc-a', 'acc-b', 10_000, 'same-key-x');
    const r = await service.transferInternal('acc-a', 'acc-b', 10_000, 'same-key-x');
    expect(r.data.created).toBe(false);
  });
});

describe('Fase-3: PIN diverifikasi server-side', () => {
  const dbStub = {
    user: {
      findUnique: async (_args: unknown) => ({ id: 'u1', pinHash: hashSecret('123456') }),
      update: async (args: unknown) => args,
    },
  } as never;

  it('PIN salah → 400 PIN_SALAH', async () => {
    const pin = new PinService(dbStub);
    await expect(pin.verify('u1', '000000')).rejects.toMatchObject({
      message: 'PIN_SALAH',
      getStatus: expect.any(Function),
    });
  });

  it('PIN benar → lolos tanpa error', async () => {
    const pin = new PinService(dbStub);
    await expect(pin.verify('u1', '123456')).resolves.toBeUndefined();
  });

  // Checklist 3: PIN salah 5x dalam jendela 1 menit → terkunci (PIN_LOCKED 403).
  it('PIN salah 5x → terkunci (403), PIN benar pun ditolak', async () => {
    const pin = new PinService(dbStub);
    for (let i = 0; i < 5; i++) {
      await expect(pin.verify('u-lock', '000000')).rejects.toMatchObject({ message: 'PIN_SALAH' });
    }
    try {
      await pin.verify('u-lock', '123456');
      throw new Error('seharusnya lock');
    } catch (e) {
      expect((e as { getStatus: () => number }).getStatus()).toBe(403);
    }
  });

  // Checklist 3: percobaan PIN paralel tidak menembus lock (race).
  it('PIN salah paralel → tepat 5 attempt dihitung lalu lock', async () => {
    const pin = new PinService(dbStub);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => pin.verify('u-race', '999999')));
    const wrong = results.filter((r) => r.status === 'rejected' && String((r as PromiseRejectedResult).reason?.message ?? '').includes('PIN_SALAH')).length;
    const locked = results.filter((r) => r.status === 'rejected' && !String((r as PromiseRejectedResult).reason?.message ?? '').includes('PIN_SALAH')).length;
    expect(wrong).toBe(5);
    expect(locked).toBe(3);
  });
});

// Checklist 3: batas saldo per tier — topup yang membuat saldo melewati cap
// tier ditolak (default T1 = 10jt, T2 = 20jt; dipakai hanya saat PrismaService ada).
describe('Batas saldo per tier (T1 = Rp10jt)', () => {
  const dbStubTier = (tier: string) => ({ user: { findUnique: async () => ({ kycTier: tier }) } }) as never;

  it('T1: topup 10jt oke, +1 rupiah ditolak SALDO_TIER_EXCEEDED', async () => {
    const store = new InMemoryWalletStore();
    const service = new WalletService(store, stubQueue(), dbStubTier('T1'));
    await service.topupBki('u-tier', 10_000_000, 'tier-1');
    await expect(service.topupBki('u-tier', 1, 'tier-2')).rejects.toMatchObject({ code: 'SALDO_TIER_EXCEEDED' });
    expect(await service.balance('u-tier')).toBe(10_000_000);
  });

  it('T1: topup 10jt01 di satu permintaan langsung ditolak', async () => {
    const store = new InMemoryWalletStore();
    const service = new WalletService(store, stubQueue(), dbStubTier('T1'));
    await expect(service.topupBki('u-tier2', 10_000_001, 'tier-3')).rejects.toMatchObject({ code: 'SALDO_TIER_EXCEEDED' });
    expect(await service.balance('u-tier2')).toBe(0);
  });
});
