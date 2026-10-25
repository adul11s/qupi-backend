import { Module } from '@nestjs/common';
import { WalletModule } from './wallet.module';
import { WalletService } from './wallet.service';
import { QueueModule } from '../queue/queue.module';
import { QueueService } from '../queue/queue.service';
import { PaymentModule } from '../payment/payment.module';
import { PaymentService } from '../payment/payment.service';

// Worker settlement (stub ala BullMQ): job payload { transactionId, debits, credits }
// -> ledger disettle (wallet). BullMQ asli menyusul saat REDIS_QUEUE=1.
// Fase-4 #2: payload QRIS { qrisId } TIDAK lagi skipped — dirute ke
// PaymentService.settleQris (PAID -> SETTLED) sesuai jenis payload.
@Module({
  imports: [WalletModule, PaymentModule, QueueModule],
  providers: [
    {
      provide: 'SETTLEMENT_WORKER',
      useFactory: (queue: QueueService, wallet: WalletService, payment: PaymentService): unknown => {
        queue.registerWorker('settlement', async (payload) => {
          const p = payload as { qrisId?: string; transactionId?: string };
          if (typeof p?.qrisId === 'string' && p.qrisId.length > 0) {
            await payment.settleQris(p.qrisId);
            return;
          }
          await wallet.settleFromQueue(payload as { transactionId: string; debits?: { accountId: string; amount: number }[]; credits?: string[] });
        });
        return true;
      },
      inject: [QueueService, WalletService, PaymentService],
    },
  ],
})
export class WorkerModule {}
