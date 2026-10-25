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
import { DomainError } from '../common/errors';

// Fase-3 #2: binding idempotensi ke payload — key sama dengan fingerprint beda
// ditolak 409 IDEM_CONFLICT (tidak di-replay, jangan salah-debit).
const assertFingerprint = (
  stored: string | undefined,
  given: string | undefined,
): void => {
  if (!stored || stored !== given) {
    throw new DomainError('IDEM_CONFLICT', 'Idempotency key dipakai untuk request berbeda (fingerprint tidak cocok)', 409 as never);
  }
};

interface Entry {
  accountId: string;
  transactionId: string;
  kind: string;
  status: string;
  counterparty?: string | null;
  userId?: string | null;
  createdAt: Date;
  direction: 'DEBIT' | 'CREDIT';
  amount: number;
}

// Adapter in-memory untuk unit test. Lock per-account disimulasikan dengan
// chained promise (mutex) — semantik sama dengan SELECT ... FOR UPDATE.
let seq = 0;
export class InMemoryWalletStore implements WalletStore {
  entries: Entry[] = [];
  transactions: Map<string, { id: string; idempotencyKey: string; status: string; kind: string; fingerprint?: string; amount?: number | null; userId?: string | null }> = new Map();
  accounts = new Map<string, { id: string; userId: string }>();
  private locks = new Map<string, Promise<unknown>>();

  // Fase-3 #2: replay hanya jika stored fingerprint === op fingerprint.
  private checkFingerprint(txId: string, given?: string): void {
    const t = [...this.transactions.values()].find((x) => x.id === txId);
    if (!t) throw new DomainError('TX_NOT_FOUND', 'Transaksi tidak ditemukan');
    assertFingerprint(t.fingerprint, given);
  }

  private nid(): string {
    seq += 1;
    return `t${seq}`;
  }

  private withLock(keys: string[], fn: () => Promise<AppliedTransaction>): Promise<AppliedTransaction> {
    const sorted = [...keys].sort();
    let prev: Promise<unknown> | null = null;
    for (const k of sorted) {
      const next = this.locks.get(k);
      if (next) prev = prev ? prev.then(() => next) : next;
    }
    const run = (async () => {
      if (prev) await prev;
      return fn();
    })();
    for (const k of sorted) {
      this.locks.set(k, run as unknown as Promise<unknown>);
    }
    return run;
  }

  private balanceOf(accountId: string): number {
    return this.entries
      .filter((e) => e.accountId === accountId && e.amount > 0)
      .reduce((acc, e) => acc + (e.direction === 'CREDIT' ? e.amount : -e.amount), 0);
  }

  private writeEntries(
    txId: string,
    debits: { accountId: string; amount: number }[],
    credits: string[],
    creditAmount: number,
  ) {
    const out: { accountId: string; direction: 'DEBIT' | 'CREDIT'; amount: number }[] = [];
    for (const d of debits) {
      this.entries.push({ accountId: d.accountId, transactionId: txId, direction: 'DEBIT', amount: d.amount, kind: '', status: 'SUCCESS', createdAt: new Date() });
      out.push({ accountId: d.accountId, direction: 'DEBIT' as const, amount: d.amount });
    }
    for (const accountId of credits) {
      this.entries.push({ accountId, transactionId: txId, direction: 'CREDIT', amount: creditAmount, kind: '', status: 'SUCCESS', createdAt: new Date() });
      out.push({ accountId, direction: 'CREDIT' as const, amount: creditAmount });
    }
    return out;
  }

  async ensureAccount(userId: string): Promise<string> {
    let acc = this.accounts.get(userId);
    if (!acc) {
      acc = { id: this.nid(), userId };
      this.accounts.set(userId, acc);
    }
    return acc.id;
  }

  async accountIdOf(userId: string): Promise<string | null> {
    return this.accounts.get(userId)?.id ?? null;
  }

  async applyTransaction(op: ApplyTransactionOp): Promise<AppliedTransaction> {
    const existed = this.transactions.get(op.idempotencyKey);
    if (existed) {
      this.checkFingerprint(existed.id, op.fingerprint);
      return this.replay(existed.id);
    }
    return this.withLock(
      op.debits.map((d) => d.accountId),
      async () => {
        const again = this.transactions.get(op.idempotencyKey);
        if (again) {
          this.checkFingerprint(again.id, op.fingerprint);
          return this.replay(again.id);
        }
        for (const d of op.debits) {
          if (this.balanceOf(d.accountId) < d.amount) {
            throw new InsufficientBalanceError(`Saldo tidak mencukupi untuk akun ${d.accountId}`);
          }
        }
        const debitsTotal = op.debits.reduce((a, d) => a + d.amount, 0);
        const txId = this.nid();
        this.transactions.set(op.idempotencyKey, {
          id: txId,
          idempotencyKey: op.idempotencyKey,
          status: 'SUCCESS',
          kind: op.kind,
          fingerprint: op.fingerprint,
          // meta utk topupCallback (webhook): amount & userId perlu tersimpan
          amount: debitsTotal,
          userId: (op as { userId?: string }).userId ?? null,
        });
        const entries = this.writeEntries(txId, op.debits, op.credits, debitsTotal);
        return { transactionId: txId, idempotencyKey: op.idempotencyKey, status: 'SUCCESS', created: true, entries };
      },
    );
  }

  async createPendingTransaction(op: PendingTransactionOp): Promise<AppliedTransaction> {
    const existed = this.transactions.get(op.idempotencyKey);
    if (existed) {
      this.checkFingerprint(existed.id, op.fingerprint);
      return this.replay(existed.id);
    }
    return this.withLock([], async () => {
      const again = this.transactions.get(op.idempotencyKey);
      if (again) {
        this.checkFingerprint(again.id, op.fingerprint);
        return this.replay(again.id);
      }
      const txId = this.nid();
      this.transactions.set(op.idempotencyKey, {
        id: txId,
        idempotencyKey: op.idempotencyKey,
        status: 'PENDING',
        kind: op.kind,
        fingerprint: op.fingerprint,
        amount: op.amount,
        userId: op.userId ?? null,
      });
      this.entries.push({
        accountId: op.accountId,
        transactionId: txId,
        direction: 'CREDIT',
        amount: -1, // placeholder PENDING; tidak ikut saldo/karena difilter amount>0
        status: 'PENDING',
        kind: op.kind,
        counterparty: op.counterparty ?? null,
        userId: op.userId ?? null,
        createdAt: new Date(),
      });
      return { transactionId: txId, idempotencyKey: op.idempotencyKey, status: 'PENDING', created: true, entries: [] };
    });
  }

  async settleTransaction(op: SettleTransactionOp): Promise<AppliedTransaction> {
    const debits = op.debits ?? [];
    return this.withLock(debits.map((d) => d.accountId), async () => {
      // Fase-6 chaos: settle pada tx yang SUDAH settle (webhook ganda) → replay
      // tanpa menulis ledger baru, saldo tidak bisa bertambah dua kali.
      const existing = [...this.transactions.values()].find((t) => t.id === op.transactionId);
      const failedOnTx = op.status === 'FAILED' && existing?.status === 'FAILED';
      if (existing && existing.status !== 'PENDING' && !failedOnTx) {
        return this.replay(op.transactionId);
      }
      for (const d of debits) {
        if (this.balanceOf(d.accountId) < d.amount) {
          throw new InsufficientBalanceError(`Saldo tidak mencukupi untuk akun ${d.accountId}`);
        }
      }
      const entries = this.writeEntries(op.transactionId, debits, op.credits ?? [], op.amount ?? 0);
      // tandai tx SUCCESS/FAILED pada metadata
      const item = [...this.transactions.values()].find((t) => t.id === op.transactionId);
      if (item) item.status = op.status;
      for (const e of this.entries) if (e.transactionId === op.transactionId) e.status = op.status;
      return { transactionId: op.transactionId, idempotencyKey: '', status: 'SUCCESS', created: true, entries };
    });
  }

  private replay(txId: string): AppliedTransaction {
    const entries = this.entries
      .filter((e) => e.transactionId === txId && e.amount > 0)
      .map((e) => ({ accountId: e.accountId, direction: e.direction, amount: e.amount }));
    return { transactionId: txId, idempotencyKey: '', status: 'SUCCESS', created: false, entries };
  }

  async getTransactionByTid(transactionId: string): Promise<{ id: string; status: string; kind: string; failReason?: string | null; counterparty?: string | null; userId?: string | null; amount?: number | null; } | null> {
    const item = [...this.transactions.values()].find((t) => t.id === transactionId);
    if (!item) return null;
    // amount dari meta; fallback agregat ledger bila meta belum terisi
    const fromLedger = this.entries
      .filter((e) => e.transactionId === transactionId && e.amount > 0)
      .reduce((a, e) => a + e.amount, 0);
    return {
      ...item,
      failReason: null,
      counterparty: null,
      amount: typeof item.amount === 'number' && item.amount > 0 ? item.amount : fromLedger,
      userId: item.userId ?? null,
    };
  }

  async getBalanceFromLedger(accountId: string): Promise<number> {
    return this.balanceOf(accountId);
  }

  async history(_accountId: string, _f: HistoryFilter): Promise<HistoryRow[]> {
    return this.entries
      .filter((e) => e.accountId === _accountId && e.amount > 0)
      .map((e) => ({ transactionId: e.transactionId, kind: e.kind, status: e.status, direction: e.direction, amount: e.amount, counterparty: e.counterparty ?? null, createdAt: e.createdAt }));
  }
}
