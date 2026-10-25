import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { Request } from 'express';
import { KeyPipe, MoneyPipe } from '../common/pipes';
import { SessionGuard } from '../common/session.guard';
import { PinService } from '../common/pin.service';
import { reqUser } from '../common/req-user';

type User = { id: string };

// Fase kritis #4: endpoint transaksi wallet wajib body { pin } (6 digit) —
// PIN diverifikasi server-side, bukan hanya tampilan modal di frontend.
@UseGuards(SessionGuard)
@Controller('wallet')
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly pin: PinService,
  ) {}

  // Top-up BKI sandbox; Idempotency-Key wajib.
  @Post('topup')
  async topup(
    @Req() req: Request,
    @Body('amount', MoneyPipe) amount: number,
    @Body('idempotencyKey', KeyPipe) idempotencyKey: string,
    @Body('pin') pin: string,
  ) {
    const user = reqUser(req) as User;
    this.pin.assertFormat(pin);
    await this.pin.verify(user.id, pin);
    return this.wallet.topupBki(user.id, amount, idempotencyKey);
  }

  // Status transaksi PENDING (polling sandbox callback).
  @Get('transactions/:tid')
  async tx(@Req() req: Request, @Param('tid') tid: string) {
    return { data: await this.wallet.txStatusOf(tid, (reqUser(req) as User).id) };
  }

  // Callback sandbox BKI bank untuk menyelesaikan transaksi PENDING.
  @Post('callback/:tid')
  async callback(
    @Req() req: Request,
    @Param('tid') tid: string,
    @Body() body: { status: 'SUCCESS' | 'FAILED' },
  ) {
    const user = reqUser(req) as User;
    const t = await this.wallet.txStatusOf(tid, user.id);
    return t.kind === 'TOPUP' ? this.wallet.topupCallback(tid, body.status) : this.wallet.bankTransferCallback(tid, body.status);
  }

  @Post('transfer')
  async transfer(
    @Req() req: Request,
    @Body() body: { toUserId: string; amount: number; pin: string },
    @Body('idempotencyKey', KeyPipe) idempotencyKey: string,
  ) {
    const user = reqUser(req) as User;
    this.pin.assertFormat(body.pin);
    await this.pin.verify(user.id, body.pin);
    return this.wallet.transferInternal(user.id, body.toUserId, Number(body.amount), idempotencyKey);
  }

  @Post('transfer/bank')
  async transferBank(
    @Req() req: Request,
    @Body() body: { bankCode: string; accountNumber: string; toUserId?: string; amount: number; pin: string },
    @Body('idempotencyKey', KeyPipe) idempotencyKey: string,
  ) {
    const user = reqUser(req) as User;
    this.pin.assertFormat(body.pin);
    await this.pin.verify(user.id, body.pin);
    return this.wallet.transferBank(user.id, Number(body.amount), idempotencyKey, body);
  }

  @Get('balance')
  async balance(@Req() req: Request) {
    const bal = await this.wallet.balance((reqUser(req) as User).id);
    return { message: 'Saldo dihitung dari ledger', data: { balance: bal } };
  }

  // Riwayat: filter tipe & tanggal & paginasi.
  @Get('history')
  async history(@Req() req: Request, @Query() q: { kind?: string; from?: string; to?: string; page?: string; limit?: string }) {
    return this.wallet.history((reqUser(req) as User).id, q);
  }
}
