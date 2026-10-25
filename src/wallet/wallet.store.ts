export class InsufficientBalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientBalanceError';
  }
}

interface LedgerOpSide {
  accountId: string;
  amount: number; // selalu positif (rupiah)
}

export interface ApplyTransactionOp {
  idempotencyKey: string;
  kind: string;
  // Fase-3 #2: fingerprint payload (userId+kind+amount+counterparty) — replay
  // hanya sah jika fingerprint sama; beda → IDEM_CONFLICT 409.
  fingerprint?: string;
  counterparty?: string | null;
  userId?: string | null;
  debits: LedgerOpSide[];
  credits: string[]; // accountIds yang dikredit (amount per akun = sama total)
}

export interface PendingTransactionOp {
  idempotencyKey: string;
  kind: string;
  // Fase-3 #2: fingerprint payload untuk binding idempotensi (lihat atas).
  fingerprint?: string;
  amount: number;
  accountId: string;
  userId?: string | null;
  counterparty?: string | null;
}

export interface SettleTransactionOp {
  transactionId: string;
  status: 'SUCCESS' | 'FAILED';
  failReason?: string | null;
  amount?: number;
  debits?: LedgerOpSide[];
  credits?: string[]; // accountIds yang dikredit
}

export interface AppliedTransaction {
  transactionId: string;
  idempotencyKey: string;
  status: string;
  created: boolean; // false = replay dari idempotency key yang sama
  entries: { accountId: string; direction: 'DEBIT' | 'CREDIT'; amount: number }[];
}

export interface HistoryFilter {
  kinds?: string[];
  from?: Date;
  to?: Date;
  page: number;
  limit: number;
}

export interface HistoryRow {
  transactionId: string;
  kind: string;
  status: string;
  direction: string;
  amount: number;
  counterparty?: string | null;
  createdAt: Date;
}

// Saldo akun dihitung dari ledger, bukan kolom cache.
export interface WalletStore {
  applyTransaction(op: ApplyTransactionOp): Promise<AppliedTransaction>;
  ensureAccount(userId: string): Promise<string>;
  accountIdOf(userId: string): Promise<string | null>;
  createPendingTransaction(op: PendingTransactionOp): Promise<AppliedTransaction>;
  settleTransaction(op: SettleTransactionOp): Promise<AppliedTransaction>;
  getTransactionByTid(transactionId: string): Promise<{
    id: string;
    status: string;
    kind: string;
    failReason?: string | null;
    counterparty?: string | null;
    userId?: string | null;
    amount?: number | null;
  } | null>;
  getBalanceFromLedger(accountId: string): Promise<number>;
  history(accountId: string, filter: HistoryFilter): Promise<HistoryRow[]>;
}
