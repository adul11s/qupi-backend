import { Module } from '@nestjs/common';
import { WalletModule } from './wallet.module';
import { WalletService } from './wallet.service';
import { QueueModule } from '../queue/queue.module';
import { QueueService } from '../queue/queue.service';

// Worker settlement (stub ala BullMQ): job payload { transactionId, debits, credits }
// -> ledger disettle (wallet). BullMQ asli menyusul saat REDIS_QUEUE=1.
@Module({
  imports: [WalletModule, QueueModule],
  providers: [
    {
      provide: 'SETTLEMENT_WORKER',
      useFactory: (queue: QueueService, wallet: WalletService): unknown => {
        queue.registerWorker('settlement', async (payload) => {
          await wallet.settleFromQueue(payload as { transactionId: string; debits?: { accountId: string; amount: number }[]; credits?: string[] });
        });
        return true;
      },
      inject: [QueueService, WalletService],
    },
  ],
})
export class WorkerModule {}
