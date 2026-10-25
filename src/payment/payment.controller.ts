import { Body, Controller, ForbiddenException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { PaymentService, QrisPayResult } from './payment.service';
import { KeyPipe, MoneyPipe } from '../common/pipes';
import { SessionGuard } from '../common/session.guard';
import { PinService } from '../common/pin.service';
import { reqUser } from '../common/req-user';
import { Request } from 'express';

@UseGuards(SessionGuard)
@Controller('payment')
export class PaymentController {
  constructor(
    private readonly payment: PaymentService,
    private readonly pin: PinService,
  ) {}

  // QRIS: buat -> bayar (BALANCE dari saldo atau PAYLATER single-debit).
  @Post('qris')
  async createQris(@Req() req: Request, @Body('amount', MoneyPipe) amount: number) {
    return this.payment.createDynamicQris(reqUser(req).id, amount);
  }

  // GET /payment/qris/:id — hanya owner (fase kritis #3 IDOR).
  @Get('qris/:id')
  async qris(@Req() req: Request, @Param('id') id: string) {
    return { data: await this.payment.getQrisOwned(reqUser(req).id, id) };
  }

  // Fase kritis #6: SATU endpoint bayar QRIS. method PAYLATER tidak pernah
  // mendebit saldo — hanya limit paylater (single debit), sinkron dalam
  // satu operasi service (limit -> paylaterTx -> cicilan -> settle QRIS).
  @Post('qris/:id/pay')
  async payQris(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { method: 'BALANCE' | 'PAYLATER'; pin: string; tenorMonths?: number },
    @Body('idempotencyKey', KeyPipe) idempotencyKey: string,
  ): Promise<QrisPayResult> {
    const user = reqUser(req);
    const method = body.method ?? 'BALANCE';
    this.pin.assertFormat(body.pin);
    await this.pin.verify(user.id, body.pin);
    return this.payment.qrisPay(user.id, id, { method, idempotencyKey, tenorMonths: body.tenorMonths ? Number(body.tenorMonths) : undefined });
  }

  // Inquiry idempotent: inquiry ulang menghasilkan inquiryId sama selama belum dibayar.
  @Post('bills/inquiry')
  async inquiry(@Req() req: Request, @Body() body: { provider: 'PLN' | 'PULSA' | 'DATA'; number: string }) {
    return {
      message: 'Inquiry berhasil',
      data: await this.payment.billInquiry(reqUser(req).id, body.provider, body.number),
    };
  }

  @Post('bills/pay')
  async pay(
    @Req() req: Request,
    @Body() body: { inquiryId: string; method: 'BALANCE' | 'PAYLATER'; pin: string },
    @Body('idempotencyKey', KeyPipe) idempotencyKey: string,
  ) {
    const user = reqUser(req);
    this.pin.assertFormat(body.pin);
    await this.pin.verify(user.id, body.pin);
    return this.payment.payBill(user.id, body.inquiryId, body.method, idempotencyKey);
  }
}

// helper tidak digunakan; dihapus
