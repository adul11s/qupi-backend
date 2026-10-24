import { Module } from '@nestjs/common';
import { IdentityModule } from './identity/identity.module';
import { WalletModule } from './wallet/wallet.module';
import { PaymentModule } from './payment/payment.module';
import { CreditModule } from './credit/credit.module';
import { RiskModule } from './risk/risk.module';
import { AdminModule } from './admin/admin.module';
import { QueueModule } from './queue/queue.module';

// Monolith modular: identity | wallet | payment | credit | risk | admin
// Queue (BullMQ) masih stub — tidak dibutuhkan untuk jalur sinkron.
@Module({
  imports: [IdentityModule, WalletModule, PaymentModule, CreditModule, RiskModule, AdminModule, QueueModule],
})
export class AppModule {}
