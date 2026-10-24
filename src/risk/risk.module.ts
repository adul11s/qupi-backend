import { Injectable, Module } from '@nestjs/common';

// Stub modul risk: evaluasi transaksi dikeluarkan hasil sederhana yang dapat
// diganti scoring lebih kompleks di task berikutnya.
@Injectable()
export class RiskService {
  evaluate(input: { userId: string; amount: number }): { approved: boolean; score: number; reason: string } {
    const score = input.amount > 10_000_000 ? 30 : 90;
    return {
      approved: score >= 40,
      score,
      reason: score >= 40 ? 'Risiko rendah' : 'Transaksi besar, butuh review',
    };
  }
}

@Module({ providers: [RiskService], exports: [RiskService] })
export class RiskModule {}
