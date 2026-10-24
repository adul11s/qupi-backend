import { Body, Controller, Post } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PrismaService } from '../common/prisma.service';

@Controller('payment')
export class PaymentController {
  constructor(
    private readonly payment: PaymentService,
    private readonly db: PrismaService,
  ) {}


  @Post('bills/inquiry')
  async inquiry(@Body() body: { provider: string; number: string }) {
    // simulasi inquiry: nominal dihasilkan dari hash nomor
    const amount = 25_000 + (body.number.length * 1_000);
    return { message: 'Inquiry berhasil', data: { provider: body.provider, number: body.number, billAmount: amount } };
  }

  @Post('bills/pay')
  async pay(@Body() body: { userId: string; provider: 'PLN' | 'PULSA' | 'DATA'; number: string; amount: number; pin?: string; idempotencyKey: string }) {
    return this.payment.payBill({ id: body.userId }, body);
  }

  }
