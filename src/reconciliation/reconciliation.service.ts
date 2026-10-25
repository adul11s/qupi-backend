import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { providerMode } from '../common/config';
import {
  ProviderReport,
  ReconDifference,
  ReconLedgerSource,
  ReconReport,
} from './reconciliation.ports';

export const RECON_LEDGER_SOURCE = 'RECON_LEDGER_SOURCE';
// Direktori tempat laporan harian ditulis (default: data/ — gitignored).
export const RECON_OUTPUT_DIR = 'RECON_OUTPUT_DIR';

// Counterparty provider eksternal: BKI-SANDBOX (topup), 'BANK:NOREK' (transfer
// bank luar), REFUND-MANUAL (refund ke jalur bank).
const PROVIDER_COUNTERPARTY_RE = /^(BKI-SANDBOX|\S+:\d+|REFUND-MANUAL)$/;

// Job rekonsiliasi harian: bandingkan agregat ledger internal dengan laporan
// provider stub (PROVIDER_MODE). Laporan JSON ditulis ke RECON_OUTPUT_DIR bila
// disetel (via scripts/reconcile.ts).
@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(RECON_LEDGER_SOURCE) private readonly source: ReconLedgerSource,
    @Optional() private readonly db?: PrismaService,
  ) {}

  async run(mode = providerMode('PROVIDER'), write = true): Promise<ReconReport> {
    const [transactions, ledger] = await Promise.all([
      this.source.listTransactions(),
      this.source.ledgerAggregate(),
    ]);
    const ledgerByTid = new Map(
      transactions.map((tx) => {
        const agg = ledger.get(tx.transactionId);
        return [tx.transactionId, { amount: (agg?.debit ?? 0) || (agg?.credit ?? 0), status: tx.status }];
      }),
    );

    const providerTxs = transactions.filter(
      (t) => PROVIDER_COUNTERPARTY_RE.test(t.counterparty ?? '') || t.kind === 'REFUND',
    );
    const summary: Record<string, { count: number; amount: number }> = {};
    for (const p of providerTxs) {
      const entry = summary[p.kind] ?? { count: 0, amount: 0 };
      entry.count += 1;
      entry.amount += p.amount;
      summary[p.kind] = entry;
    }
    const report: ProviderReport = {
      generatedAt: new Date().toISOString(),
      providerMode: mode,
      items: providerTxs.map((p) => ({
        transactionId: p.transactionId,
        kind: p.kind,
        status: p.status,
        amount: p.amount,
        counterparty: p.counterparty,
      })),
      summary,
      aggregate: { count: providerTxs.length, amount: Object.values(summary).reduce((a, s) => a + s.amount, 0) },
    };

    // selisih ledger vs provider — harus NOL pada kondisi sehat
    const differences: ReconDifference[] = [];
    for (const p of providerTxs) {
      const led = ledgerByTid.get(p.transactionId);
      if (!led) {
        differences.push({ transactionId: p.transactionId, reason: 'MISSING_IN_LEDGER', provider: { amount: p.amount, status: p.status } });
        continue;
      }
      if (led.status !== p.status) {
        differences.push({
          transactionId: p.transactionId,
          reason: 'STATUS_MISMATCH',
          ledger: { amount: led.amount, status: led.status },
          provider: { amount: p.amount, status: p.status },
        });
      }
      if (led.amount !== p.amount) {
        differences.push({
          transactionId: p.transactionId,
          reason: 'AMOUNT_MISMATCH',
          ledger: { amount: led.amount, status: led.status },
          provider: { amount: p.amount, status: p.status },
        });
      }
    }
    const ledgerOnly = transactions.filter((t) => !PROVIDER_COUNTERPARTY_RE.test(t.counterparty ?? '') && t.kind !== 'REFUND');
    void ledgerOnly;

    const result: ReconReport = {
      generatedAt: new Date().toISOString(),
      balanced: differences.length === 0,
      ledgerSummary: {
        transactions: transactions.length,
        totalDebit: [...ledger.values()].reduce((a, x) => a + x.debit, 0),
        totalCredit: [...ledger.values()].reduce((a, x) => a + x.credit, 0),
      },
      provider: { aggregate: report.aggregate, mode: report.providerMode },
      differences,
    };
    if (write) {
      await this.persist(result);
    }
    return result;
  }

  // Tulis laporan JSON harian ke RECON_OUTPUT_DIR (default data/, gitignored).
  async persist(report: ReconReport): Promise<string | null> {
    const dir = process.env.RECON_OUTPUT_DIR;
    if (!dir) return null;
    const fs = await import('fs');
    const path = await import('path');
    fs.mkdirSync(dir, { recursive: true });
    const date = report.generatedAt.slice(0, 10).replace(/-/g, '');
    const file = path.join(dir, `reconciliation-${date}-${Date.now() % 10_000}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    return file;
  }
}

// Adapter prisma (runtime): sumber kebenaran internal = tabel Transaction +
// aggregate LedgerEntry. Laporan provider dibangun dari kolom/agregat yang
// BEDA tabel — sehingga selisih bukan hasil membandingkan dua salinan sama.
export class PrismaReconSource implements ReconLedgerSource {
  constructor(private readonly db: PrismaService) {}

  async listTransactions() {
    const rows = await this.db.transaction.findMany({
      select: { id: true, kind: true, status: true, amount: true, counterparty: true, userId: true },
    });
    return rows.map((r) => ({
      transactionId: r.id,
      kind: r.kind,
      status: r.status,
      amount: r.amount,
      counterparty: r.counterparty,
      userId: r.userId,
    }));
  }

  async ledgerAggregate() {
    const rows = await this.db.ledgerEntry.groupBy({
      by: ['transactionId', 'direction'],
      where: { amount: { gt: 0 } },
      _sum: { amount: true },
    });
    const agg = new Map<string, { debit: number; credit: number }>();
    for (const r of rows) {
      const e = agg.get(r.transactionId) ?? { debit: 0, credit: 0 };
      if (r.direction === 'DEBIT') e.debit += r._sum.amount ?? 0;
      else e.credit += r._sum.amount ?? 0;
      agg.set(r.transactionId, e);
    }
    return agg;
  }
}
