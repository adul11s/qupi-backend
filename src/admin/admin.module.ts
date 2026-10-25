import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { PrismaService } from '../common/prisma.service';
import { SessionService } from '../common/session.service';
import { IdentityModule } from '../identity/identity.module';
import { WalletModule } from '../wallet/wallet.module';

// AdminRoleGuard datang dari SessionGlobalModule (PrismaService global).
// AuditService & OutboxService dari modul @Global (AuditModule/OutboxModule).
@Module({
  imports: [IdentityModule, WalletModule],
  controllers: [AdminController],
  providers: [PrismaService, SessionService],
  exports: [SessionService, PrismaService],
})
export class AdminModule {}
