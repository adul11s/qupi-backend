import { Module } from '@nestjs/common';
import { WalletService, WALLET_STORE } from './wallet.service';
import { PrismaWalletStore } from './prisma-wallet.store';
import { WalletController } from './wallet.controller';
import { PrismaService } from '../common/prisma.service';

@Module({
  controllers: [WalletController],
  providers: [PrismaService, PrismaWalletStore, { provide: WALLET_STORE, useClass: PrismaWalletStore }],
  exports: [WalletService],
})
export class WalletModule {}
