import { Module } from '@nestjs/common';
import { QueueService } from './queue.service';

// Simpan antrean in-process (stub BullMQ). Worker settlement didaftarkan
// di WalletModule; worker denda di CreditModule.
@Module({
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
