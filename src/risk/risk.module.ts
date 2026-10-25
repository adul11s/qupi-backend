import { Injectable, Module } from '@nestjs/common';

interface Rule {
  name: string;
  kind: 'TRANSFER' | 'QRIS' | 'BILL' | 'PAYLATER' | 'ANY';
  max?: number;
  maxPerDay?: number;
  action: 'REVIEW' | 'REJECT';
}

// Rules engine minimal: aturan dari RISK_RULES_JSON (default inline, mode restrict).
// Fase-4 #5: keputusan pilot 'dompet tanpa batas transaksi' — rule transfer 10jt
// DIHAPUS; yang tersisa hanya cap safety 2.500.000.000 dan batas produk tetap.
// Fase-5: rule PAYLATER max 20jt dihapus — paylater sudah digovern oleh limit
// (gaji×2.5 plafon 15jt) + DTI 25% di credit/payment service, bukan cap nominal
// per-transaksi. QRIS tetap dibatasi + rule VELOCITY harian ditambahkan.
const DEFAULT_RULES: Rule[] = [
  { name: 'transfer_safety_cap', kind: 'TRANSFER', max: 2_500_000_000, action: 'REJECT' },
  { name: 'qris_max_2jt', kind: 'QRIS', max: 2_000_000, action: 'REJECT' },
  { name: 'qris_velocity_20_per_hari', kind: 'QRIS', maxPerDay: 20, action: 'REJECT' },
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
  // context.txCountToday: jumlah transaksi sejenis user hari ini (velocity).
  evaluate(kind: string, amount: number, context: { userId: string; txCountToday?: number }): { approved: boolean; score: number; reason: string } {
    void context.userId;
    for (const r of this.rules) {
      if (r.kind !== 'ANY' && r.kind !== kind) continue;
      if (r.max !== undefined && amount > r.max) {
        return { approved: false, score: 10, reason: `Melanggar rule ${r.name}: melebihi maksimal Rp${r.max.toLocaleString('id-ID')}` };
      }
      if (r.maxPerDay !== undefined && context.txCountToday !== undefined && context.txCountToday >= r.maxPerDay) {
        return { approved: false, score: 10, reason: `Melanggar rule ${r.name}: lebih dari ${r.maxPerDay} transaksi/hari` };
      }
    }
    return { approved: true, score: 95, reason: 'Semua rule lolos' };
  }
}

@Module({ providers: [RiskService], exports: [RiskService] })
export class RiskModule {}
