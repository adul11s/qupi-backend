import {
  ApplyTransactionOp,
  AppliedTransaction,
  WalletStore,
  InsufficientBalanceError,
} from './wallet.store';

interface Entry {
  accountId: string;
  transactionId: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: number;
}

// Adapter in-memory untuk unit test. Lock per-account disimulasikan dengan
// chained promise (mutex) — semantik sama dengan SELECT ... FOR UPDATE.
let seq = 0;
export class InMemoryWalletStore implements WalletStore {
  entries: Entry[] = [];
  transactions: Map<string, { id: string; idempotencyKey: string; status: string; kind: string }> = new Map();
  private locks = new Map<string, Promise<unknown>>();

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

  async applyTransaction(op: ApplyTransactionOp): Promise<AppliedTransaction> {
    const existed = this.transactions.get(op.idempotencyKey);
    if (existed) {
      return this.replay(op, existed.id as string);
    }
    return this.withLock(
      op.debits.map((d) => d.accountId),
      async () => {
        const again = this.transactions.get(op.idempotencyKey);
        if (again) return this.replay(op, again.id as string);

        // cek saldo dari ledger di dalam lock
        for (const d of op.debits) {
          const bal = this.entries
            .filter((e) => e.accountId === d.accountId)
            .reduce((acc, e) => acc + (e.direction === 'CREDIT' ? e.amount : -e.amount), 0);
          if (bal < d.amount) {
            throw new InsufficientBalanceError(`Saldo tidak mencukupi untuk akun ${d.accountId}`);
          }
        }
        const txId = this.nid();
        this.transactions.set(op.idempotencyKey, {
          id: txId,
          idempotencyKey: op.idempotencyKey,
          status: 'SUCCESS',
          kind: op.kind,
        });
        const entries: AppliedTransaction['entries'] = [];
        for (const d of op.debits) {
          this.entries.push({ accountId: d.accountId, transactionId: txId, direction: 'DEBIT', amount: d.amount });
          entries.push({ accountId: d.accountId, direction: 'DEBIT', amount: d.amount });
        }
        for (const c of op.credits) {
          this.entries.push({ accountId: c.accountId, transactionId: txId, direction: 'CREDIT', amount: c.amount });
          entries.push({ accountId: c.accountId, direction: 'CREDIT', amount: c.amount });
        }
        return { transactionId: txId, idempotencyKey: op.idempotencyKey, status: 'SUCCESS', created: true, entries };
      },
    );
  }

  private replay(op: ApplyTransactionOp, txId: string): AppliedTransaction {
    const entries = this.entries
      .filter((e) => e.transactionId === txId)
      .map((e) => ({ accountId: e.accountId, direction: e.direction, amount: e.amount }));
    return { transactionId: txId, idempotencyKey: op.idempotencyKey, status: 'SUCCESS', created: false, entries };
  }

  async getBalanceFromLedger(accountId: string): Promise<number> {
    return this.entries
      .filter((e) => e.accountId === accountId)
      .reduce((acc, e) => acc + (e.direction === 'CREDIT' ? e.amount : -e.amount), 0);
  }
}
