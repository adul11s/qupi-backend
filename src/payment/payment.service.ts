import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { WalletService, WALLET_STORE } from '../wallet/wallet.service';
import { WalletStore } from '../wallet/wallet.store';
import { Inject } from '@nestjs/common';
import { DomainError } from '../common/errors';
import { opts } from '../common/config';

export type SimMode = 'success' | 'fail' | 'timeout';

// Simulasi provider eksternal (PLN, pulsa, data) — internal, tanpa API bayar.
// Env PROVIDER_MODE memaksa hasil: success | fail | timeout.
export function simulateProvider(mode: SimMode): SimMode {
  const forced = opts().providerMode;
  if (forced !== 'success') return forced;
  return mode;
}

@Injectable()
export class PaymentService {
  constructor(
    private readonly db: PrismaService,
    @Inject(WALLET_STORE) private readonly store: WalletStore,
    private readonly wallet: WalletService,
  ) {}

  async payBill(user: { id: string }, input: {
    provider: 'PLN' | 'PULSA' | 'DATA';
    number: string;
    amount: number;
    pin?: string;
    idempotencyKey: string;
  }) {
    if (!input.pin) throw new DomainError('PIN_REQUIRED', 'PIN wajib untuk pembayaran tagihan');
    const mode = simulateProvider('success');
    if (mode === 'timeout') {
      throw new DomainError('PROVIDER_TIMEOUT', 'Timeout menunggu provider eksternal, transaksi dibatalkan');
    }
    if (mode === 'fail') {
      const bill = await this.db.bill.create({
        data: { userId: user.id, provider: input.provider, number: input.number, amount: input.amount, status: 'FAILED' },
      });
      return { message: 'Pembayaran gagal di sisi provider', data: bill };
    }
    const tx = await this.wallet.topup(user.id /* placeholder account */, 0, input.idempotencyKey, input.number);
    void tx;
    const bill = await this.db.bill.create({
      data: {
        userId: user.id,
        provider: input.provider,
        number: input.number,
        amount: input.amount,
        status: 'PAID',
      },
    });
    return { message: 'Pembayaran tagihan berhasil', data: bill };
  }
}
