import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { PrismaService } from '../common/prisma.service';
import { SessionService } from '../common/session.service';
import { IdentityModule } from '../identity/identity.module';

// AdminRoleGuard datang dari SessionGlobalModule (PrismaService global).
@Module({
  imports: [IdentityModule],
  controllers: [AdminController],
  providers: [PrismaService, SessionService],
  exports: [SessionService, PrismaService],
})
export class AdminModule {}
