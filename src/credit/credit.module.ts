import { Module } from '@nestjs/common';
import { CreditService } from './credit.service';
import { PrismaService } from '../common/prisma.service';
import { CreditController } from './credit.controller';

@Module({
  providers: [CreditService, PrismaService],
  controllers: [CreditController],
  exports: [CreditService],
})
export class CreditModule {}
