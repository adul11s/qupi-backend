import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { KeyPipe, MoneyPipe } from '../common/pipes';
import { SessionGuard } from '../common/session.guard';
import { reqUser } from '../common/req-user';
import { Request } from 'express';

@UseGuards(SessionGuard)
@Controller('payment')
export class PaymentController {
  constructor(private readonly payment: PaymentService) {}

  // QRIS: buat -> bayar dari saldo -> SETTLED setelah queue worker stub.
  @Post('qris')
  async createQris(@Req() req: Request, @Body('amount', MoneyPipe) amount: number) {
    return this.payment.createDynamicQris(reqUser(req).id, amount);
  }

  @Get('qris/:id')
  async qris(@Param('id') id: string) {
    return { data: await this.payment.getQris(id) };
  }

  @Post('qris/:id/pay')
  async payQris(
    @Req() req: Request,
    @Param('id') id: string,
    @Body('idempotencyKey', KeyPipe) idempotencyKey: string,
  ) {
    return this.payment.payQrisFromBalance(reqUser(req).id, id, idempotencyKey);
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
    @Body() body: { inquiryId: string; method: 'BALANCE' | 'PAYLATER' },
    @Body('idempotencyKey', KeyPipe) idempotencyKey: string,
  ) {
    return this.payment.payBill(reqUser(req).id, body.inquiryId, body.method, idempotencyKey);
  }
}
