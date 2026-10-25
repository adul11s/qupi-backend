import { InMemoryWalletStore } from '../src/wallet/in-memory-wallet.store';
import { WalletService } from '../src/wallet/wallet.service';
import { PinService } from '../src/common/pin.service';
import { hashSecret } from '../src/common/hash.util';
import { DomainError } from '../src/common/errors';

// TODO(fase-4): suite ini jalan di adapter in-memory karena docker unavailable
// di env pilot — test dengan Postgres sungguhan (Temporal race + P2002 + FOR
// UPDATE betulan) harus ditambahkan di CI dengan container Postgres.

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
});
