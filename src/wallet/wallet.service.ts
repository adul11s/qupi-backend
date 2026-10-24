import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { WalletStore, TxKindT, InsufficientBalanceError } from './wallet.store';
import { DomainError } from '../common/errors';

export const WALLET_STORE = 'WALLET_STORE';

@Injectable()
export class WalletService {
  constructor(@Inject(WALLET_STORE) private readonly store: WalletStore) {}

  async topup(accountId: string, amount: number, idempotencyKey: string, counterparty?: string) {
    if (amount <= 0) throw new DomainError('AMOUNT_INVALID', 'nominal harus lebih besar dari 0');
    return this.store.applyTransaction({
      idempotencyKey,
      kind: 'TOPUP' as TxKindT,
      debits: [],
      credits: [{ accountId, amount }],
      counterparty,
    });
  }

  async transfer(fromAccountId: string, toAccountId: string, amount: number, idempotencyKey: string) {
    if (amount <= 0) throw new DomainError('AMOUNT_INVALID', 'nominal harus lebih besar dari 0');
    if (fromAccountId === toAccountId) throw new DomainError('SAME_ACCOUNT', 'tidak boleh transfer ke rekening sendiri');
    try {
      return await this.store.applyTransaction({
        idempotencyKey,
        kind: 'TRANSFER' as TxKindT,
        debits: [{ accountId: fromAccountId, amount }],
        credits: [{ accountId: toAccountId, amount }],
      });
    } catch (e) {
      if (e instanceof InsufficientBalanceError) {
        throw new DomainError('INSUFFICIENT_BALANCE', 'Saldo tidak mencukupi');
      }
      throw e;
    }
  }

  async balance(accountId: string): Promise<number> {
    return this.store.getBalanceFromLedger(accountId);
  }
}
