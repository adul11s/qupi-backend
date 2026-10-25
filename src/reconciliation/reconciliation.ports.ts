// Port untuk reconciliation: sisi "buku internal" (ledger wallet) vs sisi
// "buku provider" (laporan laporan stub provider, PROVIDER_MODE).
export interface ReconTxRow {
  transactionId: string;
  kind: string;
  status: string;
  amount: number;
  counterparty?: string | null;
  userId?: string | null;
}

export interface ReconLedgerSource {
  // Semua transaksi yang pernah disetor/ditarik dari ledger internal —
  // sumber kebenaran internal (tabel Transaction + LedgerEntry di prisma).
  listTransactions(): Promise<ReconTxRow[]>;
  // Aggregate ledger per transaksi: total debit & kredit (status != FAILED).
  ledgerAggregate(): Promise<Map<string, { debit: number; credit: number }>>;
}

export interface ReconAggregates {
  ledger: Map<string, { debit: number; credit: number }>;
  transactions: ReconTxRow[];
}

export interface ProviderReport {
  generatedAt: string;
  providerMode: string;
  items: {
    transactionId: string;
    kind: string;
    status: string;
    amount: number;
    counterparty?: string | null;
  }[];
  summary: Record<string, { count: number; amount: number }>;
  aggregate: { count: number; amount: number };
}

export interface ReconDifference {
  transactionId: string;
  reason: 'MISSING_IN_PROVIDER' | 'MISSING_IN_LEDGER' | 'STATUS_MISMATCH' | 'AMOUNT_MISMATCH';
  ledger?: { amount: number; status: string };
  provider?: { amount: number; status: string };
}

export interface ReconReport {
  generatedAt: string;
  balanced: boolean;
  ledgerSummary: { transactions: number; totalDebit: number; totalCredit: number };
  provider: { aggregate: { count: number; amount: number }; mode: string };
  differences: ReconDifference[];
}
