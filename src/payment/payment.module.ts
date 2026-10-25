import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { QueueModule } from '../queue/queue.module';
import { PrismaService } from '../common/prisma.service';

@Module({
  imports: [WalletModule, QueueModule],
  controllers: [PaymentController],
  providers: [PaymentService, PrismaService],
  exports: [PaymentService],
})
export class PaymentModule {}
