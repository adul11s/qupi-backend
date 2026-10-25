import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { DomainError } from '../common/errors';
import { opts } from '../common/config';
import { WALLET_STORE, WalletService } from '../wallet/wallet.service';
import { WalletStore } from '../wallet/wallet.store';
import { KycStatus } from '@prisma/client';

const TENORS = [1, 3, 6] as const;

const DAY = 24 * 3600 * 1000;

@Injectable()
export class CreditService {
  constructor(
    private readonly db: PrismaService,
    @Inject(WALLET_STORE) private readonly store: WalletStore,
    private readonly wallet: WalletService,
  ) {}

  // Rule-based limit stub: KTP disetujui → limit = 2.5x akumulasi topup
  // 30 hari terakhir, dibatasi 500rb–20jt.
  async computeLimit(userId: string): Promise<number> {
    const kyc = await this.db.kycDocument.findFirst({ where: { userId, kind: 'KTP', status: KycStatus.APPROVED } });
    if (!kyc) throw new DomainError('KYC_NOT_APPROVED', 'KTP belum disetujui admin', 403 as never);
    const since = new Date(Date.now() - 30 * DAY);
    const rows = await this.db.ledgerEntry.findMany({
      where: { account: { userId }, direction: 'CREDIT', amount: { gt: 0 }, createdAt: { gte: since } },
      select: { amount: true },
    });
    const topup30d = rows.reduce((a: number, r) => a + r.amount, 0);
    const o = opts();
    const raw = Math.round(topup30d * o.paylaterLimitMultiplier);
    return Math.min(o.paylaterLimitMax, Math.max(o.paylaterLimitMin, raw));
  }

  async limitOf(userId: string) {
    let used = 0;
    let limit = 0;
    let activated = false;
    const line = await this.db.payLaterLine.findUnique({ where: { userId } });
    if (line) {
      used = line.used;
      limit = line.limitAmount;
      activated = line.activated;
    } else {
      limit = await this.computeLimit(userId);
    }
    return { data: { limit, used, available: limit - used, activated } };
  }

  async activate(userId: string) {
    const limit = await this.computeLimit(userId);
    const line = await this.db.payLaterLine.upsert({
      where: { userId },
      update: { limitAmount: limit, activated: true },
      create: { userId, limitAmount: limit, activated: true },
    });
    return { message: `PayLater aktif, limit Rp${limit.toLocaleString('id-ID')}`, data: line };
  }

  payableInterestPerMonth(tenor: number): number {
    return tenor === 1 ? 0 : 1; // 30 hari: 0%; 3/6 bulan: 1% per bulan
  }

  async ensureLine(userId: string) {
    let line = await this.db.payLaterLine.findUnique({ where: { userId } });
    if (!line) {
      const limit = await this.computeLimit(userId);
      line = await this.db.payLaterLine.create({ data: { userId, limitAmount: limit, activated: true } });
    }
    return line;
  }

  // Checkout paylater: jadwal cicilan atomik + idempoten (Idempotency-Key).
  async checkout(userId: string, amount: number, tenorMonths: number, idempotencyKey: string) {
    if (!Number.isInteger(amount) || amount <= 0) throw new BadRequestException('Nominal harus integer rupiah > 0');
    if (!TENORS.includes(tenorMonths as 1 | 3 | 6)) throw new DomainError('TENOR_INVALID', 'Tenor harus 1, 3, atau 6 bulan');
    const existing = await this.db.payLaterTx.findUnique({ where: { idempotencyKey }, include: { installments: true } });
    if (existing) {
      return { message: 'Checkout sudah pernah diproses (idempoten)', data: { payLaterTxId: existing.id, installments: existing.installments.length, replay: true } };
    }
    const line = await this.ensureLine(userId);
    if (!line.activated) throw new DomainError('PAYLATER_NOT_ACTIVE', 'PayLater belum diaktivasi', 403 as never);
    if (line.used + amount > line.limitAmount) throw new DomainError('LIMIT_EXCEEDED', 'Limit PayLater tidak mencukupi');

    // bunga: tenor 1 (≤30 hari) 0%; 3/6 bulan 1% per bulan
    const totalInterest = Math.round((amount * this.payableInterestPerMonth(tenorMonths) * tenorMonths) / 100);
    const totalAmount = amount + totalInterest;
    const per = Math.round(totalAmount / tenorMonths);

    const payLaterTx = await this.db.$transaction(async (tx: import('@prisma/client').Prisma.TransactionClient): Promise<string> => {
      const pl = await tx.payLaterTx.create({
        data: { lineId: line.id, amount, totalAmount, totalInterest, tenorMonths, idempotencyKey },
      });
      for (let seq = 1; seq <= tenorMonths; seq++) {
        const amt = seq === tenorMonths ? totalAmount - per * (tenorMonths - 1) : per;
        await tx.payLaterInstallment.create({
          data: { payLaterTxId: pl.id, seq, dueAt: new Date(Date.now() + seq * 30 * DAY), amount: amt },
        });
      }
      await tx.payLaterLine.update({ where: { id: line.id }, data: { used: { increment: amount } } });
      return pl.id;
    });
    return { message: `Checkout paylater berhasil, ${tenorMonths}x cicilan dibuat`, data: { payLaterTxId: payLaterTx, totalAmount, totalInterest } };
  }

  // Daftar cicilan milik user (untuk halaman paylater).
  async listInstallments(userId: string) {
    const line = await this.db.payLaterLine.findUnique({ where: { userId } });
    if (!line) return { data: [] };
    const insts = await this.db.payLaterInstallment.findMany({
      where: { payLaterTx: { lineId: line.id } },
      orderBy: { seq: 'asc' },
      select: { id: true, seq: true, dueAt: true, amount: true, penalty: true, status: true, paidAt: true, payLaterTxId: true },
    });
    return { data: insts };
  }

  // Bayar cicilan dari saldo; idempoten via Transaction.idempotencyKey unique.
  async payInstallment(userId: string, installmentId: string, idempotencyKey: string) {
    const inst = await this.db.payLaterInstallment.findUnique({
      where: { id: installmentId },
      include: { payLaterTx: { include: { line: true } } },
    });
    if (!inst) throw new DomainError('NOT_FOUND', 'Cicilan tidak ditemukan');
    if (inst.payLaterTx.line.userId !== userId) throw new DomainError('FORBIDDEN', 'Cicilan bukan milik akun ini', 403 as never);
    if (inst.status === 'PAID') return { message: 'Cicilan sudah pernah dibayar (idempoten)', data: { installmentId } };
    await this.recomputePenaltyFor(inst.id);
    const fresh = await this.db.payLaterInstallment.findUniqueOrThrow({ where: { id: installmentId } });
    const total = fresh.amount + fresh.penalty;
    try {
      const res = await this.store.applyTransaction({
        idempotencyKey,
        kind: 'INSTALLMENT',
        userId,
        counterparty: inst.payLaterTxId,
        debits: [{ accountId: await this.store.ensureAccount(userId), amount: total }],
        credits: [await this.store.ensureAccount('paylater-treasury')],
      });
      if (!res.created) {
        return { message: 'Pembayaran cicilan sudah pernah diproses (idempoten)', data: { installmentId } };
      }
      await this.db.payLaterInstallment.update({
        where: { id: installmentId },
        data: { status: 'PAID', paidAt: new Date(), transactionId: res.transactionId, penalty: fresh.penalty },
      });
      await this.db.payLaterLine.update({ where: { id: inst.payLaterTx.lineId }, data: { used: { decrement: inst.payLaterTx.amount } } });
      return { message: `Cicilan berhasil dibayar (total ${total.toLocaleString('id-ID')} ${fresh.penalty ? 'termasuk denda' : ''})`, data: { installmentId, total, penalty: fresh.penalty } };
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'InsufficientBalanceError') throw new DomainError('INSUFFICIENT_BALANCE', 'Saldo tidak mencukupi untuk cicilan');
      throw e;
    }
  }

  private async recomputePenaltyFor(instId: string): Promise<number> {
    const inst = await this.db.payLaterInstallment.findUnique({ where: { id: instId } });
    if (!inst || inst.status === 'PAID') return 0;
    const past = Date.now() - inst.dueAt.getTime();
    if (past <= 0) {
      if (inst.status === 'LATE') await this.db.payLaterInstallment.update({ where: { id: instId }, data: { status: 'UNPAID', penalty: 0 } });
      return 0;
    }
    const daysLate = Math.ceil(past / DAY);
    const penalty = Math.round((inst.amount * opts().penaltyPctPerDay * daysLate) / 100);
    await this.db.payLaterInstallment.update({ where: { id: instId }, data: { status: 'LATE', penalty } });
    return penalty;
  }

  // Rekonsiliasi denda manual: tandai cicilan lewat tempo jadi LATE + denda 1%/hari.
  async recomputePenalties(userId?: string): Promise<{ updated: number }> {
    const lines = await this.db.payLaterLine.findMany({ where: userId ? { userId } : {} });
    let updated = 0;
    for (const line of lines) {
      const insts = await this.db.payLaterInstallment.findMany({ where: { payLaterTx: { lineId: line.id } } });
      for (const inst of insts) {
        if (inst.status !== 'PAID' && inst.dueAt.getTime() < Date.now()) {
          const before = inst.penalty;
          const after = await this.recomputePenaltyFor(inst.id);
          if (after !== before) updated++;
        }
      }
    }
    return { updated };
  }

  // Rekap tagihan paylater: cicilan belum bayar + jatuh tempo (>30 hari).
  async recap(userId: string) {
    const line = await this.db.payLaterLine.findUnique({ where: { userId } });
    if (!line) return { data: { limit: 0, used: 0, unpaidTotal: 0, dueBeyond30dTotal: 0, overdueTotal: 0, installmentCount: 0 } };
    const insts = await this.db.payLaterInstallment.findMany({ where: { payLaterTx: { lineId: line.id } } });
    const unpaid = insts.filter((i: { status: string }) => i.status !== 'PAID');
    const unpaidTotal = unpaid.reduce((a: number, i: { amount: number; penalty: number }) => a + i.amount + i.penalty, 0);
    const beyond30 = insts.filter((i: { dueAt: { getTime(): number } }) => i.dueAt.getTime() > Date.now() + 30 * DAY);
    const overdue = insts.filter((i: { status: string }) => i.status === 'LATE');
    return {
      data: {
        limit: line.limitAmount,
        used: line.used,
        unpaidTotal,
        dueBeyond30dTotal: beyond30.reduce((a: number, i: { amount: number; penalty: number }) => a + i.amount + i.penalty, 0),
        overdueTotal: overdue.reduce((a: number, i: { amount: number; penalty: number }) => a + i.amount + i.penalty, 0),
        installmentCount: unpaid.length,
      },
    };
  }

  async jobIdempotentList(userId: string) {
    const line = await this.db.payLaterLine.findUnique({ where: { userId }, include: { payLaterTxs: { include: { installments: true } } } });
    return line?.payLaterTxs ?? [];
  }

  async historyForUser(userId: string) {
    const line = await this.db.payLaterLine.findUnique({ where: { userId } });
    if (!line) return { data: { limit: 0, used: 0, unpaidTotal: 0, dueBeyond30dTotal: 0, overdueTotal: 0, installmentCount: 0 } };
    return this.recap(userId);
  }

  async walletBalanceFor(userId: string) {
    return this.wallet.balance(userId);
  }
}
