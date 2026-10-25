import { Module } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { IdentityController } from './identity.controller';
import { PrismaIdentityRepository } from './prisma-identity.repository';
import { PrismaService } from '../common/prisma.service';
import { IdentityRepository } from './identity.repository';
import { IdentityOptions } from './identity.service';
import { SessionService } from '../common/session.service';

const IDENTITY_REPO = 'IDENTITY_REPO';

@Module({
  controllers: [IdentityController],
  providers: [
    PrismaService,
    PrismaIdentityRepository,
    SessionService,
    { provide: IDENTITY_REPO, useExisting: PrismaIdentityRepository },
    {
      provide: IdentityService,
      useFactory: (repo: IdentityRepository): IdentityService =>
        new IdentityService(repo, {
          pinMaxAttempts: Number(process.env.PIN_MAX_ATTEMPTS ?? 5),
          otpTtlMinutes: Number(process.env.OTP_TTL_MINUTES ?? 5),
          otpMaxPerMinute: Number(process.env.OTP_MAX_PER_MINUTE ?? 3),
        } satisfies IdentityOptions),
      inject: [IDENTITY_REPO],
    },
  ],
  exports: [IdentityService, SessionService, PrismaService],
})
export class IdentityModule {}
