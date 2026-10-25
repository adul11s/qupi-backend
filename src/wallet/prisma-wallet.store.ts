import { Injectable } from '@nestjs/common';
import { TxKind } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { DomainError } from '../common/errors';
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
    // userId nullable → dua jenis akun: user wajib (punya baris User, FK),
    // dan akun virtual/sistem (merchant stub MRC-STUB-001, suspense vault)
    // tanpa User — dibuat dengan id deterministik supaya idempotent.
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (user) {
      try {
        const acc = await this.db.walletAccount.upsert({
          where: { userId },
          update: {},
          create: { userId },
        });
        return acc.id;
      } catch (err) {
        // Dua request paralel bisa upsert userId sama — upsert unique(userId)
        // melempar P2002 "Unique constraint failed on the fields: (userId)"
        // bahkan dengan create kosong. Aman: pemenang membuat baris, yang
        // kalah cukup baca ulang — hasil tetap konsisten.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const existing = await this.db.walletAccount.findUnique({ where: { userId } });
          if (existing) return existing.id;
        }
        throw err;
      }
    }
    const virtId = `virtual:${userId}`;
    const acc = await this.db.walletAccount.upsert({
      where: { id: virtId },
      update: {},
      create: { id: virtId, userId: null },
    });
    return acc.id;
  }

  async accountIdOf(userId: string): Promise<string | null> {
    const acc = await this.db.walletAccount.findUnique({ where: { userId } });
    return acc?.id ?? null;
  }

  private replayOf(t: { id: string; idempotencyKey: string }, entries: { accountId: string; direction: 'DEBIT' | 'CREDIT'; amount: number }[]): AppliedTransaction {
    return { transactionId: t.id, idempotencyKey: t.idempotencyKey, status: 'SUCCESS', created: false, entries };
  }

  // Fase-3 #2: key sama tapi race paralel P2002 tetap membandingkan fingerprint.
  private replayWithFingerprint(
    existing: { id: string; idempotencyKey: string; fingerprint?: string | null },
    op: { fingerprint?: string },
    entries: { accountId: string; direction: 'DEBIT' | 'CREDIT'; amount: number }[],
  ): AppliedTransaction {
    // Fingerprint lama yang belum ter-set (kolom baru nullable) tidak dianggap cocok:
    // key dipakai ulang lintas niat memang harus ditolak (409 IDEM_CONFLICT).
    if (!existing.fingerprint || existing.fingerprint !== op.fingerprint) {
      throw new DomainError('IDEM_CONFLICT', 'Idempotency key dipakai untuk request berbeda (fingerprint tidak cocok)', 409 as never);
    }
    return this.replayOf(existing, entries);
  }

  async applyTransaction(op: ApplyTransactionOp): Promise<AppliedTransaction> {
    try {
      return await this.doApplyTransaction(op);
    } catch (e: unknown) {
      // Fase-2 #3: race idempotency di DB — request paralel dengan key sama
      // menabrak UNIQUE(idempotencyKey) → REPLAY hasil yang sudah ada, bukan 500.
      if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002') {
        const existing = await this.db.transaction.findUnique({ where: { idempotencyKey: op.idempotencyKey } });
        if (existing) {
          const entries = await this.db.ledgerEntry.findMany({ where: { transactionId: existing.id } });
          return this.replayWithFingerprint(existing, op, entries.map((en) => ({
            accountId: en.accountId,
            direction: en.direction as 'DEBIT' | 'CREDIT',
            amount: en.amount,
          })));
        }
      }
      throw e;
    }
  }

  private async doApplyTransaction(op: ApplyTransactionOp): Promise<AppliedTransaction> {
    return this.db.$transaction(
      async (tx: import('@prisma/client').Prisma.TransactionClient): Promise<AppliedTransaction> => {
        const existing = await tx.transaction.findUnique({ where: { idempotencyKey: op.idempotencyKey } });
        if (existing) {
          const entries = await tx.ledgerEntry.findMany({ where: { transactionId: existing.id } });
          return this.replayWithFingerprint(existing, op, entries.map((e) => ({
            accountId: e.accountId,
            direction: e.direction as 'DEBIT' | 'CREDIT',
            amount: e.amount,
          })));
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
            fingerprint: op.fingerprint ?? null,
          },
        });
        const entries: AppliedTransaction['entries'] = [];
        // Kredit-only (funding eksternal tanpa debit pairs) — didebit ke suspense
        // supaya invariant tetap berimbang; dalam praktik jalur ini lewat
        // settleTransaction, tapi guard defensif di sini.
        if (debitsTotal === 0 && op.credits.length > 0) {
          const suspense = await tx.walletAccount.upsert({
            where: { id: 'virtual:external-funding-suspense' },
            update: {},
            create: { id: 'virtual:external-funding-suspense', userId: null },
          });
          await tx.ledgerEntry.create({
            data: { accountId: suspense.id, transactionId: transaction.id, direction: 'DEBIT', amount: op.credits.length * transaction.amount },
          });
          entries.push({ accountId: suspense.id, direction: 'DEBIT', amount: op.credits.length * transaction.amount });
          for (const accountId of op.credits) {
            await tx.ledgerEntry.create({
              data: { accountId, transactionId: transaction.id, direction: 'CREDIT', amount: transaction.amount },
            });
            entries.push({ accountId, direction: 'CREDIT', amount: transaction.amount });
          }
          return { transactionId: transaction.id, idempotencyKey: transaction.idempotencyKey, status: 'SUCCESS', created: true, entries };
        }
        // Invariant universal: Σdebit == Σkredit untuk SEMUA transaksi.
        // Dana masuk tanpa debit → debit virtual funding-suspense;
        // dana keluar tanpa kredit → kredit virtual payout-clearing.
        const creditsTotal = op.credits.length * debitsTotal;
        if (debitsTotal > creditsTotal) {
          const balance = await tx.walletAccount.upsert({
            where: { id: 'virtual:external-payout-clearing' },
            update: {},
            create: { id: 'virtual:external-payout-clearing', userId: null },
          });
          await tx.ledgerEntry.create({
            data: { accountId: balance.id, transactionId: transaction.id, direction: 'CREDIT', amount: debitsTotal - creditsTotal },
          });
          entries.push({ accountId: balance.id, direction: 'CREDIT', amount: debitsTotal - creditsTotal });
        }
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
          fingerprint: op.fingerprint ?? null,
        },
      });
      // tandai account id di field counterparty supaya polos
      return { transactionId: tx.id, idempotencyKey: tx.idempotencyKey, status: 'PENDING', created: true, entries: [] };
    } catch (e: unknown) {
      if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002') {
        const existing = await this.db.transaction.findUnique({ where: { idempotencyKey: op.idempotencyKey } });
        if (existing) {
          this.replayWithFingerprint(existing, op, []);
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
          // Double-entry: maxlen kredit tanpa debit pairs (top-up/callback dari
          // sumber eksternal) wajib didebit ke vault/suspense internal supaya
          // invariant Σdebit == Σkredit tetap terjaga di seluruh ledger.
          const creditTotal = (op.credits ?? []).length * transaction.amount;
          const debitTotal = (op.debits ?? []).reduce((a, d) => a + d.amount, 0);
          if (creditTotal > debitTotal) {
            const suspense = await tx.walletAccount.upsert({
              where: { id: 'virtual:external-funding-suspense' },
              update: {},
              create: { id: 'virtual:external-funding-suspense', userId: null },
            });
            await tx.ledgerEntry.create({
              data: { accountId: suspense.id, transactionId: transaction.id, direction: 'DEBIT', amount: creditTotal - debitTotal },
            });
            entries.push({ accountId: suspense.id, direction: 'DEBIT', amount: creditTotal - debitTotal });
          }
          if (debitTotal > creditTotal) {
            // Dana keluar (transfer bank ke rekening luar, refund ke BKI) —
            // sisi eksternal dikredit ke clearing akun virtual, invariant tetap.
            const clearing = await tx.walletAccount.upsert({
              where: { id: 'virtual:external-payout-clearing' },
              update: {},
              create: { id: 'virtual:external-payout-clearing', userId: null },
            });
            await tx.ledgerEntry.create({
              data: { accountId: clearing.id, transactionId: transaction.id, direction: 'CREDIT', amount: debitTotal - creditTotal },
            });
            entries.push({ accountId: clearing.id, direction: 'CREDIT', amount: debitTotal - creditTotal });
          }
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
      select: { id: true, status: true, kind: true, failReason: true, counterparty: true, amount: true, userId: true },
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
