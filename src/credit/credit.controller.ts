import { Body, Controller, Post } from '@nestjs/common';
import { CreditService } from './credit.service';

@Controller('credit')
export class CreditController {
  constructor(private readonly credit: CreditService) {}

  @Post('paylater/activate')
  async activate(@Body() body: { userId: string; limit: number }) {
    return this.credit.activate(body.userId, body.limit);
  }

  @Post('paylater/purchase')
  async purchase(@Body() body: { userId: string; amount: number; tenorMonths: 1 | 3 | 6 }) {
    return this.credit.purchase(body.userId, body.amount, body.tenorMonths);
  }

  @Post('installments/:id/pay')
  async pay(@Body() body: { userId: string }, id: string) {
    return this.credit.payInstallment(body.userId, id);
  }
}
