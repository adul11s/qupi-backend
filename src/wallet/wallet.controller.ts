import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { randomUUID } from 'crypto';

@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Post(':id/topup')
  async topup(@Param('id') id: string, @Body() body: { amount: number; idempotencyKey?: string }) {
    const key = body.idempotencyKey ?? randomUUID();
    const res = await this.wallet.topup(id, body.amount, key);
    return { message: 'Top up berhasil', data: res };
  }

  @Post(':id/transfer')
  async transfer(
    @Param('id') id: string,
    @Body() body: { toAccountId: string; amount: number; idempotencyKey?: string },
  ) {
    if (!body.idempotencyKey) {
      throw new Error('idempotencyKey wajib untuk transfer');
    }
    const res = await this.wallet.transfer(id, body.toAccountId, body.amount, body.idempotencyKey);
    return { message: 'Transfer berhasil', data: res };
  }

  @Get(':id/balance')
  async balance(@Param('id') id: string) {
    const balance = await this.wallet.balance(id);
    return { message: `Saldo: Rp${balance.toLocaleString('id-ID')}`, data: { balance } };
  }
}
