import { Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { RECON_LEDGER_SOURCE, ReconciliationService } from './reconciliation.service';
import { PrismaReconSource } from './reconciliation.service';

// Rekonsiliasi harian dijalankan via scripts/reconcile.ts (cron/CI) — modul
// ini dipasang di AppModule supaya service juga bisa dipanggil programmatically.
@Module({
  providers: [
    {
      provide: RECON_LEDGER_SOURCE,
      useFactory: (db: PrismaService) => new PrismaReconSource(db),
      inject: [PrismaService],
    },
    ReconciliationService,
  ],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
