import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { SessionService } from './session.service';

/** Satu instance SessionService + PrismaService untuk semua modul (SessionGuard APP_GUARD, wallet, payment, credit, admin). */
@Global()
@Module({
  providers: [PrismaService, SessionService],
  exports: [PrismaService, SessionService],
})
export class SessionGlobalModule {}
