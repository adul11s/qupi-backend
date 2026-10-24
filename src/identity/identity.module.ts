import { Module } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { PrismaIdentityRepository } from './prisma-identity.repository';
import { PrismaService } from '../common/prisma.service';
import { IdentityController } from './identity.controller';

@Module({
  controllers: [IdentityController],
  providers: [
    PrismaService,
    IdentityService,
    { provide: 'IdentityRepository', useClass: PrismaIdentityRepository },
  ],
  exports: [IdentityService],
})
export class IdentityModule {}
