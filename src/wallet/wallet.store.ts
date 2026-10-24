export type TxKindT = 'TOPUP' | 'TRANSFER' | 'QRIS' | 'BILL' | 'INSTALLMENT' | 'PAYLATER_PURCHASE';
export interface LedgerOpSide {
  accountId: string;
  amount: number; // selalu positif (rupiah)
}

export interface ApplyTransactionOp {
  idempotencyKey: string;
  kind: TxKindT;
  counterparty?: string | null;
  debits: LedgerOpSide[];
  credits: LedgerOpSide[];
}

export interface AppliedTransaction {
  transactionId: string;
  idempotencyKey: string;
  status: 'SUCCESS';
  created: boolean; // false = replay dari idempotency key yang sama
  entries: { accountId: string; direction: 'DEBIT' | 'CREDIT'; amount: number }[];
}

// Saldo akun dihitung dari ledger, bukan kolom cache.
export interface WalletStore {
  /** Debit HARUS dieksekusi di dalam lock atomik agar saldo tidak pernah negatif. */
  applyTransaction(op: ApplyTransactionOp): Promise<AppliedTransaction>;
  getBalanceFromLedger(accountId: string): Promise<number>;
}

export class InsufficientBalanceError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'InsufficientBalanceError';
  }
}
export class DuplicateTransactionError extends Error {
  constructor() {
    super('Transaksi idempotenti sedang diproses ulang selesai');
    this.name = 'DuplicateTransactionError';
  }
}
export const sumLedger = (entries: { direction: string; amount: number }[]): number =>
  entries.reduce((acc, e) => acc + (e.direction === 'CREDIT' ? e.amount : -e.amount), 0);
