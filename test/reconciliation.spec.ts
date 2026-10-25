import { ReconciliationService, PrismaReconSource } from '../src/reconciliation/reconciliation.service';
import { ReconLedgerSource, ReconTxRow } from '../src/reconciliation/reconciliation.ports';

// Ledger stub: baris Transaction + aggregate LedgerEntry.
const tx = (id: string, kind: string, amount: number, status = 'SUCCESS', counterparty = 'BKI-SANDBOX'): ReconTxRow => ({
  transactionId: id,
  kind,
  status,
  amount,
  counterparty,
  userId: 'u-1',
});

const balancedSource = (transactions: ReconTxRow[]): ReconLedgerSource => ({
  listTransactions: async () => transactions,
  ledgerAggregate: async () => new Map(transactions.map((t) => [t.transactionId, { debit: t.kind === 'TOPUP' ? 0 : t.amount, credit: t.kind === 'TOPUP' ? t.amount : 0 }])),
});

describe('Reconciliation: ledger vs provider report', () => {
  it('kondisi sehat: selisih NOL (balanced=true, differences=[])', async () => {
    const src = balancedSource([
      tx('tx-top-1', 'TOPUP', 500_000),
      tx('tx-bank-1', 'TRANSFER_BANK', 50_000, 'SUCCESS', 'BANK:123456'),
      tx('tx-ref-1', 'REFUND', 10_000, 'SUCCESS', 'acc-u1'),
    ]);
    const svc = new ReconciliationService(src);
    const report = await svc.run('success', false); // write=false — tidak menulis file saat test
    expect(report.balanced).toBe(true);
    expect(report.differences).toHaveLength(0);
    expect(report.provider.aggregate).toEqual({ count: 3, amount: 560_000 });
    expect(report.provider.mode).toBe('success');
  });

  it('mismatch: amount ledger tidak cocok dgn provider terdeteksi (AMOUNT_MISMATCH)', async () => {
    // ledger view & provider view sengaja dipasang beda arah: provider ref,
    // ledger debit berbeda nominal — melihat fault nyata bukan membandingkan
    // dua salinan dari pola yang sama.
    const svc = new ReconciliationService({
      listTransactions: async () => [
        tx('tx-ref-1', 'REFUND', 10_000, 'SUCCESS', 'acc-u1'), // provider: 10.000
      ],
      ledgerAggregate: async () => new Map([['tx-ref-1', { debit: 25_000, credit: 0 }]]), // ledger: 25.000
    });
    const report = await svc.run('success', false);
    expect(report.balanced).toBe(false);
    expect(report.differences).toContainEqual(
      expect.objectContaining({
        transactionId: 'tx-ref-1',
        reason: 'AMOUNT_MISMATCH',
        ledger: { amount: 25_000, status: 'SUCCESS' },
        provider: { amount: 10_000, status: 'SUCCESS' },
      }),
    );
  });

  it('tx tanpa ledger entry (amount 0) -> AMOUNT_MISMATCH dgn ledger amount 0', async () => {
    const svc = new ReconciliationService({
      listTransactions: async () => [tx('tx-top-9', 'TOPUP', 100_000)],
      ledgerAggregate: async () => new Map(),
    });
    const report = await svc.run('success', false);
    expect(report.balanced).toBe(false);
    expect(report.differences).toHaveLength(1);
    expect(report.differences[0].reason).toBe('AMOUNT_MISMATCH');
    expect(report.differences[0].ledger?.amount).toBe(0);
  });

  it('PrismaReconSource diekspor sebagai konstruktor adapter prisma', () => {
    expect(typeof PrismaReconSource).toBe('function');
  });
});
