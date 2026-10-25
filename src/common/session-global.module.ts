import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { SessionService } from './session.service';
import { PinService } from './pin.service';

/** Satu instance SessionService + PrismaService untuk semua modul (SessionGuard APP_GUARD, wallet, payment, credit, admin). */
@Global()
@Module({
  providers: [PrismaService, SessionService, PinService],
  exports: [PrismaService, SessionService, PinService],
})
export class SessionGlobalModule {}
