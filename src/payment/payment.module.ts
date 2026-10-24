import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { WalletModule } from '../wallet/wallet.module';
import { PrismaService } from '../common/prisma.service';
import { PaymentController } from './payment.controller';

@Module({
  imports: [WalletModule],
  providers: [PaymentService, PrismaService],
  controllers: [PaymentController],
  exports: [PaymentService],
})
export class PaymentModule {}
