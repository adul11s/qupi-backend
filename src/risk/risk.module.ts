import { Injectable, Module } from '@nestjs/common';

interface Rule {
  name: string;
  kind: 'TRANSFER' | 'QRIS' | 'BILL' | 'PAYLATER' | 'ANY';
  max: number;
  action: 'REVIEW' | 'REJECT';
}

// Rules engine minimal: aturan dari RISK_RULES_JSON (default inline, mode restrict).
const DEFAULT_RULES: Rule[] = [
// Fase-4 #5: keputusan pilot 'dompet tanpa batas transaksi' — batas 10jt transfer
// dihapus; digantikan cap safety 2.500.000.000 (integer validator di AmountPipe).
  { name: 'transfer_max_2_5M', kind: 'TRANSFER', max: 2_500_000_000, action: 'REJECT' },
  { name: 'qris_max_2jt', kind: 'QRIS', max: 2_000_000, action: 'REJECT' },
  { name: 'paylater_max_20jt', kind: 'PAYLATER', max: 20_000_000, action: 'REJECT' },
];

@Injectable()
export class RiskService {
  private readonly rules: Rule[];

  constructor() {
    try {
      this.rules = process.env.RISK_RULES_JSON ? JSON.parse(process.env.RISK_RULES_JSON) as Rule[] : DEFAULT_RULES;
    } catch {
      this.rules = DEFAULT_RULES; // fail-closed ke default bila JSON rusak
    }
  }

  // restrict mode: rule dilanggar -> tolak transaksi.
  evaluate(kind: string, amount: number, context: { userId: string }): { approved: boolean; score: number; reason: string } {
    void context.userId;
    for (const r of this.rules) {
      if ((r.kind === 'ANY' || r.kind === kind) && amount > r.max) {
        return { approved: false, score: 10, reason: `Melanggar rule ${r.name}: melebihi maksimal Rp${r.max.toLocaleString('id-ID')}` };
      }
    }
    return { approved: true, score: 95, reason: 'Semua rule lolos' };
  }
}

@Module({ providers: [RiskService], exports: [RiskService] })
export class RiskModule {}
