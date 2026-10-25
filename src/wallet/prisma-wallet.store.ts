import { Injectable } from '@nestjs/common';
import { TxKind } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import {
  ApplyTransactionOp,
  AppliedTransaction,
  PendingTransactionOp,
  SettleTransactionOp,
  WalletStore,
  InsufficientBalanceError,
  HistoryFilter,
  HistoryRow,
} from './wallet.store';

// Adapter Prisma: debits dilakukan dalam satu interactive transaction dengan
// SELECT ... FOR UPDATE (row lock) sehingga saldo tidak pernah negatif walau
// ada banyak request paralel. Idempotency key dijamin UNIQUE di level DB.
@Injectable()
export class PrismaWalletStore implements WalletStore {
  constructor(private readonly db: PrismaService) {}

  private balanceFromRows(rows: { direction: string; amount: number }[]): number {
    return rows.reduce(
      (acc: number, e) => acc + (e.direction === 'CREDIT' ? e.amount : -e.amount),
      0,
    );
  }

  async ensureAccount(userId: string): Promise<string> {
    const acc = await this.db.walletAccount.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
    return acc.id;
  }

  async accountIdOf(userId: string): Promise<string | null> {
    const acc = await this.db.walletAccount.findUnique({ where: { userId } });
    return acc?.id ?? null;
  }

  async applyTransaction(op: ApplyTransactionOp): Promise<AppliedTransaction> {
    return this.db.$transaction(
      async (tx: import('@prisma/client').Prisma.TransactionClient): Promise<AppliedTransaction> => {
        const existing = await tx.transaction.findUnique({ where: { idempotencyKey: op.idempotencyKey } });
        if (existing) {
          const entries = await tx.ledgerEntry.findMany({ where: { transactionId: existing.id } });
          return {
            transactionId: existing.id,
            idempotencyKey: existing.idempotencyKey,
            status: 'SUCCESS',
            created: false,
            entries: entries.map((e) => ({
              accountId: e.accountId,
              direction: e.direction as 'DEBIT' | 'CREDIT',
              amount: e.amount,
            })),
          };
        }
        // total debits harus sama dengan total credits (double-entry lagi)
        const debitsTotal = op.debits.reduce((a, d) => a + d.amount, 0);

        for (const d of op.debits) {
          await tx.$queryRaw`SELECT "id", "balance" FROM "WalletAccount" WHERE "id" = ${d.accountId} FOR UPDATE`;
          const rows = await tx.ledgerEntry.findMany({
            where: { accountId: d.accountId },
            select: { direction: true, amount: true },
          });
          const balance = this.balanceFromRows(rows);
          if (balance < d.amount) {
            throw new InsufficientBalanceError(`Saldo tidak mencukupi untuk akun ${d.accountId}`);
          }
        }

        const transaction = await tx.transaction.create({
          data: {
            idempotencyKey: op.idempotencyKey,
            kind: op.kind as TxKind,
            status: 'SUCCESS',
            amount: debitsTotal || op.credits.length,
            counterparty: op.counterparty ?? null,
            userId: op.userId ?? null,
          },
        });
        const entries: AppliedTransaction['entries'] = [];
        for (const d of op.debits) {
          await tx.ledgerEntry.create({
            data: { accountId: d.accountId, transactionId: transaction.id, direction: 'DEBIT', amount: d.amount },
          });
          entries.push({ accountId: d.accountId, direction: 'DEBIT', amount: d.amount });
        }
        for (const accountId of op.credits) {
          await tx.ledgerEntry.create({
            data: { accountId, transactionId: transaction.id, direction: 'CREDIT', amount: debitsTotal },
          });
          entries.push({ accountId, direction: 'CREDIT', amount: debitsTotal });
        }
        return {
          transactionId: transaction.id,
          idempotencyKey: transaction.idempotencyKey,
          status: 'SUCCESS',
          created: true,
          entries,
        };
      },
    );
  }

  async createPendingTransaction(op: PendingTransactionOp): Promise<AppliedTransaction> {
    try {
      const tx = await this.db.transaction.create({
        data: {
          idempotencyKey: op.idempotencyKey,
          kind: op.kind as TxKind,
          status: 'PENDING',
          amount: op.amount,
          counterparty: op.counterparty ?? null,
          userId: op.userId ?? null,
        },
      });
      // tandai account id di field counterparty supaya polos
      return { transactionId: tx.id, idempotencyKey: tx.idempotencyKey, status: 'PENDING', created: true, entries: [] };
    } catch (e: unknown) {
      if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002') {
        const existing = await this.db.transaction.findUnique({ where: { idempotencyKey: op.idempotencyKey } });
        if (existing) {
          return {
            transactionId: existing.id,
            idempotencyKey: existing.idempotencyKey,
            status: existing.status,
            created: false,
            entries: [],
          };
        }
      }
      throw e;
    }
  }

  async settleTransaction(op: SettleTransactionOp): Promise<AppliedTransaction> {
    return this.db.$transaction(
      async (tx: import('@prisma/client').Prisma.TransactionClient): Promise<AppliedTransaction> => {
        const transaction = await tx.transaction.findUnique({ where: { id: op.transactionId }, include: { ledgerEntries: true } });
        if (!transaction) throw new Error('Transaksi tidak ditemukan untuk settlement');
        if (transaction.status === 'PENDING') {
          await tx.transaction.update({
            where: { id: op.transactionId },
            data: { status: op.status, failReason: op.failReason ?? null },
          });
        } else {
          return { transactionId: transaction.id, idempotencyKey: transaction.idempotencyKey, status: transaction.status, created: false, entries: [] };
        }
        const entries: AppliedTransaction['entries'] = [];
        if (op.status === 'SUCCESS') {
          for (const d of op.debits ?? []) {
            await tx.$queryRaw`SELECT "id" FROM "WalletAccount" WHERE "id" = ${d.accountId} FOR UPDATE`;
            const rows = await tx.ledgerEntry.findMany({ where: { accountId: d.accountId }, select: { direction: true, amount: true } });
            const balance = this.balanceFromRows(rows);
            if (balance < d.amount) throw new InsufficientBalanceError(`Saldo tidak mencukupi untuk akun ${d.accountId}`);
          }
          for (const d of op.debits ?? []) {
            await tx.ledgerEntry.create({ data: { accountId: d.accountId, transactionId: op.transactionId, direction: 'DEBIT', amount: d.amount } });
            entries.push({ accountId: d.accountId, direction: 'DEBIT', amount: d.amount });
          }
          for (const accountId of op.credits ?? []) {
            await tx.ledgerEntry.create({ data: { accountId, transactionId: op.transactionId, direction: 'CREDIT', amount: transaction.amount } });
            entries.push({ accountId, direction: 'CREDIT', amount: transaction.amount });
          }
        }
        return {
          transactionId: op.transactionId,
          idempotencyKey: transaction.idempotencyKey,
          status: op.status,
          created: true,
          entries,
        };
      },
    );
  }

  async getTransactionByTid(transactionId: string) {
    const t = await this.db.transaction.findUnique({
      where: { id: transactionId },
      select: { id: true, status: true, kind: true, failReason: true, counterparty: true, amount: true },
    });
    return t;
  }

  async getBalanceFromLedger(accountId: string): Promise<number> {
    const rows = await this.db.ledgerEntry.findMany({
      where: { accountId },
      select: { direction: true, amount: true },
    });
    return this.balanceFromRows(rows);
  }

  async history(accountId: string, filter: HistoryFilter): Promise<HistoryRow[]> {
    const rows = await this.db.transaction.findMany({
      where: {
        ledgerEntries: { some: { accountId, amount: { gt: 0 } } },
        ...(filter.kinds?.length ? { kind: { in: filter.kinds } } : {}),
        ...(filter.from || filter.to
          ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
          : {}),
      } as never,
      orderBy: { createdAt: 'desc' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    // direction per akun
    const txIds = rows.map((r) => r.id);
    const entries = await this.db.ledgerEntry.findMany({ where: { transactionId: { in: txIds }, accountId } });
    const dirMap = new Map(entries.map((e) => [e.transactionId, e.direction]));
    return rows.map((r) => ({
      transactionId: r.id,
      kind: r.kind as string,
      status: r.status,
      direction: dirMap.get(r.id) ?? 'CREDIT',
      amount: r.amount,
      counterparty: r.counterparty,
      createdAt: r.createdAt,
    }));
  }
}
