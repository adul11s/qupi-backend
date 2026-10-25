import { Module } from '@nestjs/common';
import { CreditService } from './credit.service';
import { CreditController } from './credit.controller';
import { WalletModule } from '../wallet/wallet.module';
import { QueueModule } from '../queue/queue.module';
import { PrismaService } from '../common/prisma.service';
import { RiskModule } from '../risk/risk.module';

// Worker denda (stub terjadwal ala BullMQ): job 'penalty' -> recompute denda
// semua user; endpoint manual /credit/paylater/penalties/recompute tersedia.
@Module({
  imports: [WalletModule, QueueModule, RiskModule],
  controllers: [CreditController],
  providers: [CreditService, PrismaService],
  exports: [CreditService],
})
export class CreditModule {}
