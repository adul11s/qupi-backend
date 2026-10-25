import { Body, Controller, Get, Param, Post, Req, UseGuards, Query, HttpCode } from '@nestjs/common';
import { CreditService } from './credit.service';
import { KeyPipe, MoneyPipe } from '../common/pipes';
import { SessionGuard, Public } from '../common/session.guard';
import { reqUser } from '../common/req-user';
import { Request } from 'express';

@UseGuards(SessionGuard)
@Controller('credit')
export class CreditController {
  constructor(private readonly credit: CreditService) {}

  // Info limit (rule-based: KTP disetujui -> 2.5x topup 30 hari clamped).
  @Get('paylater/limit')
  async limit(@Req() req: Request) {
    return this.credit.limitOf(reqUser(req).id);
  }

  @Post('paylater/activate')
  async activate(@Req() req: Request) {
    return this.credit.activate(reqUser(req).id);
  }

  // Checkout paylater: tenor 1/3/6 bulan; Idempotency-Key wajib.
  @Post('paylater/checkout')
  async checkout(
    @Req() req: Request,
    @Body('amount', MoneyPipe) amount: number,
    @Body('tenorMonths') tenorMonths: number,
    @Body('idempotencyKey', KeyPipe) idempotencyKey: string,
  ) {
    return this.credit.checkout(reqUser(req).id, amount, Number(tenorMonths), idempotencyKey);
  }

  @Get('paylater/recap')
  async recap(@Req() req: Request) {
    return this.credit.recap(reqUser(req).id);
  }

  // Daftar cicilan milik user.
  @Get('paylater/installments')
  async installments(@Req() req: Request) {
    return this.credit.listInstallments(reqUser(req).id);
  }

  // Bayar cicilan dari saldo.
  @Post('paylater/installments/:id/pay')
  async payInstallment(
    @Req() req: Request,
    @Param('id') id: string,
    @Body('idempotencyKey', KeyPipe) idempotencyKey: string,
  ) {
    return this.credit.payInstallment(reqUser(req).id, id, idempotencyKey);
  }

  // Rekonsiliasi denda manual (1%/hari lewat jatuh tempo).
  @Post('paylater/penalties/recompute')
  async recompute(@Req() req: Request, @Body() body: { userId?: string }) {
    return this.credit.recomputePenalties(body.userId ?? reqUser(req).id);
  }
}
