import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { DomainError } from '../common/errors';

const TENORS = [1, 3, 6] as const;

@Injectable()
export class CreditService {
  constructor(private readonly db: PrismaService) {}

  async activate(userId: string, limitAmount: number) {
    const line = await this.db.payLaterLine.upsert({
      where: { userId },
      update: { limitAmount, activated: true },
      create: { userId, limitAmount, activated: true },
    });
    return { message: 'PayLater aktif', data: line };
  }

  async lineOf(userId: string) {
    return this.db.payLaterLine.findUnique({ where: { userId } });
  }

  // Pembelian paylater membagi jadi cicilan tenor 1/3/6 bulan.
  async purchase(userId: string, amount: number, tenorMonths: 1 | 3 | 6) {
    if (!TENORS.includes(tenorMonths)) throw new DomainError('TENOR_INVALID', 'Tenor harus 1, 3, atau 6 bulan');
    const line = await this.lineOf(userId);
    if (!line?.activated) throw new DomainError('PAYLATER_NOT_ACTIVE', 'PayLater belum aktif');
    if (line.used + amount > line.limitAmount) {
      throw new DomainError('LIMIT_EXCEEDED', 'Limit PayLater tidak mencukupi');
    }

    const tx = await this.db.$transaction(async (db: import('@prisma/client').Prisma.TransactionClient) => {
      const payLaterTx = await db.payLaterTx.create({
        data: { lineId: line.id, amount, tenorMonths },
      });
      const perInstallment = Math.ceil(amount / tenorMonths);
      for (let seq = 1; seq <= tenorMonths; seq++) {
        const amt = seq === tenorMonths ? amount - perInstallment * (tenorMonths - 1) : perInstallment;
        await db.payLaterInstallment.create({
          data: {
            payLaterTxId: payLaterTx.id,
            seq,
            dueAt: new Date(Date.now() + seq * 30 * 24 * 3600 * 1000),
            amount: amt,
          },
        });
      }
      await db.payLaterLine.update({ where: { id: line.id }, data: { used: { increment: amount } } });
      return payLaterTx;
    });

    return { message: 'Pembelian paylater berhasil', data: { payLaterTxId: tx.id, tenor: tenorMonths } };
  }

  async payInstallment(userId: string, installmentId: string) {
    const inst = await this.db.payLaterInstallment.findUnique({
      where: { id: installmentId },
      include: { payLaterTx: { include: { line: true } } },
    });
    if (!inst) throw new DomainError('NOT_FOUND', 'Cicilan tidak ditemukan');
    if (inst.payLaterTx.line.userId !== userId) throw new DomainError('FORBIDDEN', 'Cicilan bukan milik user ini');
    if (inst.status === 'PAID') throw new DomainError('ALREADY_PAID', 'Cicilan sudah dibayar');
    await this.db.payLaterInstallment.update({ where: { id: installmentId }, data: { status: 'PAID' } });
    await this.db.payLaterLine.update({
      where: { id: inst.payLaterTx.lineId },
      data: { used: { decrement: inst.amount } },
    });
    return { message: 'Cicilan dibayar', data: { installmentId } };
  }
}
