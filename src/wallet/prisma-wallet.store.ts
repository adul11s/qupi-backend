import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import {
  ApplyTransactionOp,
  AppliedTransaction,
  WalletStore,
  InsufficientBalanceError,
} from './wallet.store';

// Adapter Prisma: debits dilakukan dalam satu interactive transaction dengan
// SELECT ... FOR UPDATE (row lock) sehingga saldo tidak pernah negatif walau
// ada banyak request paralel. Idempotency key dijamin UNIQUE di level DB.
@Injectable()
export class PrismaWalletStore implements WalletStore {
  constructor(private readonly db: PrismaService) {}

  async applyTransaction(op: ApplyTransactionOp): Promise<AppliedTransaction> {
    return this.db.$transaction(async (tx: import('@prisma/client').Prisma.TransactionClient): Promise<AppliedTransaction> => {
      const existing = await tx.transaction.findUnique({ where: { idempotencyKey: op.idempotencyKey } });
      if (existing) {
        const entries = await tx.ledgerEntry.findMany({ where: { transactionId: existing.id } });
        return {
          transactionId: existing.id,
          idempotencyKey: existing.idempotencyKey,
          status: 'SUCCESS',
          created: false,
          entries: entries.map((e) => ({ accountId: e.accountId, direction: e.direction as 'DEBIT' | 'CREDIT', amount: e.amount })),
        } as AppliedTransaction;
      }

      // Kunci baris akun yang didebit supaya saldo paralel tidak bisa liar.
      for (const d of op.debits) {
        await tx.$queryRaw`SELECT "id", "balance" FROM "WalletAccount" WHERE "id" = ${d.accountId} FOR UPDATE`;
        
        // saldo = sum(CREDIT) - sum(DEBIT); Prisma aggregate tidak bedakan arah,
        // jadi hitung manual dari entries.
        const rows = await tx.ledgerEntry.findMany({
          where: { accountId: d.accountId },
          select: { direction: true, amount: true },
        });
        const balance = rows.reduce((acc: number, e: { direction: string; amount: number }) => acc + (e.direction === 'CREDIT' ? e.amount : -e.amount), 0);
        if (balance < d.amount) {
          throw new InsufficientBalanceError(`Saldo tidak mencukupi untuk akun ${d.accountId}`);
        }
        
      }

      const transaction = await tx.transaction.create({
        data: {
          idempotencyKey: op.idempotencyKey,
          kind: op.kind,
          status: 'SUCCESS',
          amount: op.debits.reduce((a, d) => a + d.amount, 0),
          counterparty: op.counterparty ?? null,
        },
      });
      const entries: AppliedTransaction['entries'] = [];
      for (const d of op.debits) {
        await tx.ledgerEntry.create({
          data: { accountId: d.accountId, transactionId: transaction.id, direction: 'DEBIT', amount: d.amount },
        });
        entries.push({ accountId: d.accountId, direction: 'DEBIT', amount: d.amount });
      }
      for (const c of op.credits) {
        await tx.ledgerEntry.create({
          data: { accountId: c.accountId, transactionId: transaction.id, direction: 'CREDIT', amount: c.amount },
        });
        entries.push({ accountId: c.accountId, direction: 'CREDIT', amount: c.amount });
      }
      return {
        transactionId: transaction.id,
        idempotencyKey: transaction.idempotencyKey,
        status: 'SUCCESS',
        created: true,
        entries,
      };
    });
  }

  async getBalanceFromLedger(accountId: string): Promise<number> {
    const rows = await this.db.ledgerEntry.findMany({
      where: { accountId },
      select: { direction: true, amount: true },
    });
    return rows.reduce((acc: number, e: { direction: string; amount: number }) => acc + (e.direction === 'CREDIT' ? e.amount : -e.amount), 0);
  }
}
