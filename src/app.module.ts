import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { IdentityModule } from './identity/identity.module';
import { WalletModule } from './wallet/wallet.module';
import { PaymentModule } from './payment/payment.module';
import { CreditModule } from './credit/credit.module';
import { RiskModule } from './risk/risk.module';
import { AdminModule } from './admin/admin.module';
import { QueueModule } from './queue/queue.module';
import { WorkerModule } from './wallet/worker.module';
import { SessionGuard } from './common/session.guard';
import { SessionGlobalModule } from './common/session-global.module';
import { SessionService } from './common/session.service';
import { PrismaService } from './common/prisma.service';

// Monolith modular: identity | wallet | payment | credit | risk | admin
// Sesi global: SessionGuard dengan @Public() untuk endpoint terbuka.
@Module({
  imports: [SessionGlobalModule, IdentityModule, WalletModule, PaymentModule, CreditModule, RiskModule, AdminModule, QueueModule, WorkerModule],
  providers: [
    { provide: APP_GUARD, useClass: SessionGuard },
    SessionService,
    PrismaService,
  ],
})
export class AppModule {}
