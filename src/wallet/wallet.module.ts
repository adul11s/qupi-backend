import { Module } from '@nestjs/common';
import { WalletService, WALLET_STORE } from './wallet.service';
import { PrismaWalletStore } from './prisma-wallet.store';
import { WalletController } from './wallet.controller';
import { InternalCallbackController } from './internal-callback.controller';
import { PrismaService } from '../common/prisma.service';
import { QueueModule } from '../queue/queue.module';
import { RiskModule } from '../risk/risk.module';

@Module({
  imports: [QueueModule, RiskModule],
  controllers: [WalletController, InternalCallbackController],
  providers: [PrismaService, PrismaWalletStore, { provide: WALLET_STORE, useClass: PrismaWalletStore }, WalletService],
  exports: [WalletService, { provide: WALLET_STORE, useExisting: PrismaWalletStore }],
})
export class WalletModule {}
