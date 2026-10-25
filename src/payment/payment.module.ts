import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { QueueModule } from '../queue/queue.module';
import { PrismaService } from '../common/prisma.service';
import { RiskModule } from '../risk/risk.module';

@Module({
  imports: [WalletModule, QueueModule, RiskModule],
  controllers: [PaymentController],
  providers: [PaymentService, PrismaService],
  exports: [PaymentService],
})
export class PaymentModule {}
