import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../common/errors';
import {
  WalletStore,
  InsufficientBalanceError,
  HistoryFilter,
} from './wallet.store';
import { providerMode } from '../common/config';
import { QueueService } from '../queue/queue.service';

export const WALLET_STORE = 'WALLET_STORE';

@Injectable()
export class WalletService {
  constructor(
    @Inject(WALLET_STORE) private readonly store: WalletStore,
    private readonly queue: QueueService,
  ) {}

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
    await this.store.settleTransaction({ transactionId, status, failReason: status === 'FAILED' ? 'BKI_MENOLAK' : null, credits: [] });
    return { message: `Top up ${status === 'SUCCESS' ? 'berhasil disettle' : 'digagalkan'} via callback sandbox` };
  }

  async transferInternal(userId: string, toUserId: string, amount: number, idempotencyKey: string) {
    if (amount <= 0) throw new BadRequestException('Nominal harus lebih dari 0');
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
    const destAccountId = to.toUserId ? await this.store.ensureAccount(to.toUserId) : `BANK-EXTERNAL-${to.bankCode}`;
    this.queue.enqueue('settlement', { transactionId: pending.transactionId, debits: [{ accountId: from, amount }], credits: [destAccountId] });
    return { message: 'Transfer bank ikut PENDING, status akan disettle via pekerja/callback', data: await this.store.getTransactionByTid(pending.transactionId) };
  }

  async settleFromQueue(payload: { transactionId: string; debits?: { accountId: string; amount: number }[]; credits?: string[] }) {
    const tx = await this.store.getTransactionByTid(payload.transactionId);
    if (!tx || tx.status !== 'PENDING') return { skipped: true };
    await this.store.settleTransaction({
      transactionId: payload.transactionId,
      status: 'SUCCESS',
      amount: 0,
      debits: payload.debits ?? [],
      credits: payload.credits ?? [],
    });
    return { settled: payload.transactionId };
  }

  async bankTransferCallback(transactionId: string, status: 'SUCCESS' | 'FAILED') {
    await this.store.settleTransaction({ transactionId, status, failReason: status === 'FAILED' ? 'BANK_MENOLAK' : null });
    return { message: `Transfer bank ${status === 'SUCCESS' ? 'sukses' : 'gagal'} via callback sandbox` };
  }

  async txStatusOf(tid: string, userId: string) {
    const t = await this.store.getTransactionByTid(tid);
    if (!t) throw new DomainError('TX_NOT_FOUND', 'Transaksi tidak ditemukan');
    void userId;
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
