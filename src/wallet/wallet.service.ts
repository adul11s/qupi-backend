import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../common/errors';
import {
  WalletStore,
  InsufficientBalanceError,
  HistoryFilter,
} from './wallet.store';
import { providerMode, tierCapFor } from '../common/config';
import { RiskService } from '../risk/risk.module';
import { PrismaService } from '../common/prisma.service';
import { QueueService } from '../queue/queue.service';

export const WALLET_STORE = 'WALLET_STORE';

// Fase kritis #7: callback topup harus mengkredit ledger milik user — bukan
// credits: [] yang membuat saldo user tidak naik.
@Injectable()
export class WalletService {
  constructor(
    @Inject(WALLET_STORE) private readonly store: WalletStore,
    private readonly queue: QueueService,
    private readonly db?: PrismaService, // opsional: test in-memory tanpa DB
    private readonly risk?: RiskService, // opsional: test unit lama tetap jalan
  ) {}

  // Fase-2 #8: RiskService kini benar-benar dipanggil untuk transfer (>10jt REJECT).
  private assertRisk(kind: string, amount: number, userId: string): void {
    if (!this.risk) return;
    const verdict = this.risk.evaluate(kind, amount, { userId });
    if (!verdict.approved) throw new DomainError('RISK_BLOCK', verdict.reason, 403 as never);
  }

  // Fase-2 #7: batas SALDO sesuai tier — topup yang membuat saldo melewati batas ditolak (bounce).
  private async assertTierCap(userId: string, crediting: number): Promise<void> {
    if (!this.db) return;
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { kycTier: true } });
    const cap = tierCapFor(user?.kycTier ?? 'T1');
    const current = await this.balance(userId);
    if (current + crediting > cap) {
      throw new DomainError('SALDO_TIER_EXCEEDED', `Saldo maksimal ${user?.kycTier ?? 'T1'} adalah Rp${cap.toLocaleString('id-ID')}`);
    }
  }

  private throwInsufficient(e: unknown): never {
    if (e instanceof InsufficientBalanceError) {
      throw new DomainError('INSUFFICIENT_BALANCE', 'Saldo tidak mencukupi');
    }
    throw e as Error;
  }

  async accountId(userId: string): Promise<string> {
    return this.store.ensureAccount(userId);
  }

  async topupBki(userId: string, amount: number, idempotencyKey: string) {
    if (amount <= 0 || !Number.isInteger(amount)) throw new BadRequestException('Nominal harus integer rupiah > 0');
    if (!idempotencyKey) throw new BadRequestException('Idempotency-Key wajib diisi');
    await this.assertTierCap(userId, amount);
    const accountId = await this.accountId(userId);
    const pending = await this.store.createPendingTransaction({
      idempotencyKey,
      kind: 'TOPUP',
      amount,
      accountId,
      userId,
      counterparty: 'BKI-SANDBOX',
    });
    if (!pending.created) {
      return { message: 'Top up sudah pernah diproses (idempoten)', data: await this.store.getTransactionByTid(pending.transactionId) };
    }
    const mode = providerMode('BKI');
    if (mode === 'fail') {
      await this.store.settleTransaction({ transactionId: pending.transactionId, status: 'FAILED', failReason: 'BKI_MENOLAK', amount });
      return { message: 'Top up gagal di sisi BKI sandbox', data: await this.store.getTransactionByTid(pending.transactionId) };
    }
    if (mode === 'timeout') {
      // simulasikan provider tak merespons: tergantung POLLING/OK disetel persetujuannya via callback atau pekerja.
      this.queue.enqueue('settlement', { transactionId: pending.transactionId });
      return {
        message: 'Top up sedang diproses, mohon tunggu (PENDING); gunakan callback/polling untuk menyudahkan',
        data: await this.store.getTransactionByTid(pending.transactionId),
      };
    }
    const settled = await this.store.settleTransaction({ transactionId: pending.transactionId, status: 'SUCCESS', amount, credits: [accountId] });
    return { message: 'Top up berhasil', data: await this.store.getTransactionByTid(settled.transactionId) };
  }

  // Callback sandbox BKI: menyudahkan transaksi TAHAN PENDING.
  async topupCallback(transactionId: string, status: 'SUCCESS' | 'FAILED') {
    const t = await this.store.getTransactionByTid(transactionId);
    if (!t || !t.userId || typeof t.amount !== "number") throw new DomainError("TX_NOT_FOUND", "Transaksi tidak ditemukan");
    // kredit ke account milik user (ledger), bukan kosong.
    await this.store.settleTransaction({
      transactionId,
      status,
      failReason: status === 'FAILED' ? 'BKI_MENOLAK' : null,
      amount: t.amount,
      credits: status === 'SUCCESS' && t.userId ? [await this.store.ensureAccount(t.userId)] : [],
    });
    return { message: `Top up ${status === 'SUCCESS' ? 'berhasil disettle' : 'digagalkan'} via callback sandbox` };
  }

  async transferInternal(userId: string, toUserId: string, amount: number, idempotencyKey: string) {
    if (amount <= 0) throw new BadRequestException('Nominal harus lebih dari 0');
    this.assertRisk('TRANSFER', amount, userId);
    const from = await this.accountId(userId);
    const to = await this.store.ensureAccount(toUserId);
    try {
      const res = await this.store.applyTransaction({
        idempotencyKey,
        kind: 'TRANSFER',
        userId,
        counterparty: toUserId,
        debits: [{ accountId: from, amount }],
        credits: [to],
      });
      return {
        message: res.created ? 'Transfer berhasil' : 'Transfer sudah pernah diproses (idempoten)',
        data: res,
      };
    } catch (e: unknown) {
      this.throwInsufficient(e);
    }
  }

  async transferBank(userId: string, amount: number, idempotencyKey: string, to: { bankCode: string; accountNumber: string; toUserId?: string }) {
    if (amount <= 0) throw new BadRequestException('Nominal harus lebih dari 0');
    this.assertRisk('TRANSFER', amount, userId);
    const from = await this.accountId(userId);
    const counterparty = `${to.bankCode}:${to.accountNumber}`;
    const pending = await this.store.createPendingTransaction({
      idempotencyKey,
      kind: 'TRANSFER',
      amount,
      accountId: from,
      userId,
      counterparty,
    });
    if (!pending.created) {
      return { message: 'Transfer sudah pernah diproses (idempoten)', data: await this.store.getTransactionByTid(pending.transactionId) };
    }
    const mode = providerMode('BANK');
    if (mode === 'fail') {
      await this.store.settleTransaction({ transactionId: pending.transactionId, status: 'FAILED', failReason: 'BANK_TIDAK_SOLOK_TERIMA', amount });
      return { message: 'Transfer bank gagal di sisi provider sandbox', data: await this.store.getTransactionByTid(pending.transactionId) };
    }
    const destAccountId = to.toUserId ? await this.store.ensureAccount(to.toUserId) : null;
    // Rekening luar (tanpa toUserId): tidak ada account ledger internal tujuan —
    // settle tanpa credit (uang keluar ke bank luar), sehingga tidak stuck PENDING.
    this.queue.enqueue('settlement', {
      transactionId: pending.transactionId,
      debits: [{ accountId: from, amount }],
      credits: destAccountId ? [destAccountId] : [],
    });
    return { message: 'Transfer bank ikut PENDING, status akan disettle via pekerja/callback', data: await this.store.getTransactionByTid(pending.transactionId) };
  }

  async settleFromQueue(payload: { transactionId: string; debits?: { accountId: string; amount: number }[]; credits?: string[] }) {
    const tx = await this.store.getTransactionByTid(payload.transactionId);
    if (!tx || tx.status !== 'PENDING') return { skipped: true };
    try {
      await this.store.settleTransaction({
        transactionId: payload.transactionId,
        status: 'SUCCESS',
        amount: tx.amount,
        debits: payload.debits ?? [],
        credits: payload.credits ?? [],
      });
    } catch (e: unknown) {
      // Fallback anti-stuck: settle engine gagal (mis. FK account tidak ada) ->
      // tandai FAILED dari user id di transaction, bukan biarkan PENDING selamanya.
      await this.store.settleTransaction({
        transactionId: payload.transactionId,
        status: 'FAILED',
        failReason: `SETTLE_ENGINE_GAGAL: ${(e as Error).message}`,
      });
      return { failed: payload.transactionId, reason: (e as Error).message };
    }
    return { settled: payload.transactionId };
  }

  async bankTransferCallback(transactionId: string, status: 'SUCCESS' | 'FAILED') {
    const t = await this.store.getTransactionByTid(transactionId);
    if (!t || !t.userId || typeof t.amount !== "number") throw new DomainError("TX_NOT_FOUND", "Transaksi tidak ditemukan");
    try {
      if (status === 'SUCCESS') {
        // Settle ulang debits dari user id di transaction supaya uang benar-benar
        // keluar dari ledger user (fallback:userId dari stack transfer).
        await this.store.settleTransaction({
          transactionId,
          status,
          amount: t.amount,
          debits: [{ accountId: await this.store.ensureAccount(t.userId), amount: t.amount }],
          credits: [],
        });
      } else {
        await this.store.settleTransaction({ transactionId, status, failReason: 'BANK_MENOLAK' });
      }
    } catch (e: unknown) {
      await this.store.settleTransaction({ transactionId, status: 'FAILED', failReason: `BANK_SETTLE_GAGAL: ${(e as Error).message}` });
      return { message: 'Transfer bank digagalkan (settle engine gagal), tidak stuck' };
    }
    return { message: `Transfer bank ${status === 'SUCCESS' ? 'sukses' : 'gagal'} via callback sandbox` };
  }

  // Fase kritis #3: status transaksi HANYA untuk owner (userId di tx), sisanya 403.
  async txStatusOf(tid: string, userId: string) {
    const t = await this.store.getTransactionByTid(tid);
    if (!t) throw new DomainError('TX_NOT_FOUND', 'Transaksi tidak ditemukan');
    if (t.userId !== userId) throw new ForbiddenException('Transaksi bukan milik akun ini (FORBIDDEN)');
    return t;
  }

  async balance(userId: string): Promise<number> {
    const accountId = await this.accountId(userId);
    return this.store.getBalanceFromLedger(accountId);
  }

  async history(userId: string, q: { kind?: string; from?: string; to?: string; page?: string; limit?: string }) {
    const accountId = await this.accountId(userId);
    const filter: HistoryFilter = {
      kinds: q.kind ? [q.kind] : undefined,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      page: Math.max(1, Number(q.page ?? 1)),
      limit: Math.min(100, Math.max(1, Number(q.limit ?? 20))),
    };
    const rows = await this.store.history(accountId, filter);
    return {
      message: 'Riwayat transaksi',
      data: { page: filter.page, limit: filter.limit, items: rows },
    };
  }
}
