import { Body, Controller, ForbiddenException, Get, Param, Post, Req, UseGuards, Query, HttpCode } from '@nestjs/common';
import { CreditService } from './credit.service';
import { KeyPipe, MoneyPipe } from '../common/pipes';
import { SessionGuard, Public } from '../common/session.guard';
import { PinService } from '../common/pin.service';
import { reqUser } from '../common/req-user';
import { Request } from 'express';

@UseGuards(SessionGuard)
@Controller('credit')
export class CreditController {
  constructor(
    private readonly credit: CreditService,
    private readonly pin: PinService,
  ) {}

  // Info limit (rule-based: KTP disetujui -> 2.5x topup 30 hari clamped).
  @Get('paylater/limit')
  async limit(@Req() req: Request) {
    return this.credit.limitOf(reqUser(req).id);
  }

  @Post('paylater/activate')
  async activate(@Req() req: Request) {
    return this.credit.activate(reqUser(req).id);
  }

  // Checkout paylater: tenor 1/3/6 bulan; PIN wajib (fase kritis #4).
  @Post('paylater/checkout')
  async checkout(
    @Req() req: Request,
    @Body('amount', MoneyPipe) amount: number,
    @Body('tenorMonths') tenorMonths: number,
    @Body('idempotencyKey', KeyPipe) idempotencyKey: string,
    @Body('pin') pin: string,
  ) {
    const user = reqUser(req);
    this.pin.assertFormat(pin);
    await this.pin.verify(user.id, pin);
    return this.credit.checkout(user.id, amount, Number(tenorMonths), idempotencyKey);
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

  // Bayar cicilan dari saldo — PIN wajib.
  @Post('paylater/installments/:id/pay')
  async payInstallment(
    @Req() req: Request,
    @Param('id') id: string,
    @Body('idempotencyKey', KeyPipe) idempotencyKey: string,
    @Body('pin') pin: string,
  ) {
    const user = reqUser(req);
    this.pin.assertFormat(pin);
    await this.pin.verify(user.id, pin);
    return this.credit.payInstallment(user.id, id, idempotencyKey);
  }

  // Rekonsiliasi denda manual — hanya admin boleh recompute user lain.
  @Post('paylater/penalties/recompute')
  async recompute(@Req() req: Request, @Body() body: { userId?: string }) {
    const user = reqUser(req);
    if (body.userId && body.userId !== user.id) {
      // IDOR medium: hanya admin yang boleh recompute atas nama user lain.
      throw new ForbiddenException('Hanya admin boleh recompute user lain');
    }
    return this.credit.recomputePenalties(user.id);
  }
}
