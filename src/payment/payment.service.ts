import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { WALLET_STORE, WalletService } from '../wallet/wallet.service';
import { WalletStore } from '../wallet/wallet.store';
import { DomainError } from '../common/errors';
import { opts, providerMode } from '../common/config';
import { QueueService } from '../queue/queue.service';

export interface InquiryInfo {
  inquiryId: string;
  provider: string;
  number: string;
  customerName: string;
  amount: number;
  adminFee: number;
}

// Simulasi provider tagihan internal: mode dari env BILL_MODE/PROVIDER_MODE.
@Injectable()
export class PaymentService {
  constructor(
    private readonly db: PrismaService,
    @Inject(WALLET_STORE) private readonly store: WalletStore,
    private readonly wallet: WalletService,
    private readonly queue: QueueService,
  ) {}

  // QRIS dinamis untuk merchant stub — harus checkout dalam 30 detik.
  async createDynamicQris(userId: string, amount: number) {
    if (!Number.isInteger(amount) || amount <= 0) throw new BadRequestException('Nominal harus integer rupiah > 0');
    const expiresAt = new Date(Date.now() + opts().qrisTtlSeconds * 1000);
    const qris = await this.db.qrisPayment.create({
      data: {
        userId,
        merchantId: 'MRC-STUB-001',
        merchantName: 'Kopi Kuning (merchant stub)',
        amount,
        qrisPayload: `00020101021226${String(amount).padStart(6, '0')}QUPI${Date.now()}`,
        status: 'PENDING',
        expiresAt,
      },
    });
    return { message: 'QRIS berhasil dibuat, checkout dalam 30 detik', data: qris };
  }

  async getQris(id: string) {
    const q = await this.db.qrisPayment.findUnique({ where: { id } });
    if (!q) throw new DomainError('QRIS_NOT_FOUND', 'QRIS tidak ditemukan');
    return q;
  }

  // Bayar QRIS dari saldo. Setelah proses, settlement dikirim ke queue stub.
  async payQrisFromBalance(userId: string, qrisId: string, idempotencyKey: string) {
    const qris = await this.getQris(qrisId);
    if (qris.status !== 'PENDING') throw new DomainError('QRIS_USED', 'QRIS sudah dipakai');
    if (Date.now() > qris.expiresAt.getTime()) {
      throw new DomainError('QRIS_EXPIRED', 'QRIS kedaluwarsa (checkout melebihi 30 detik)');
    }
    const tx = await this.wallet.transferInternal(userId, qris.merchantId, qris.amount, idempotencyKey);
    await this.db.qrisPayment.update({ where: { id: qrisId }, data: { status: 'PAID' } });
    this.queue.enqueue('settlement', { qrisId });
    return { message: 'QRIS berhasil dibayar', data: { qris, transaction: tx } };
  }

  // Settlement intra: sinkronisasi ledger via queue worker stub (merchant stub).
  async settleQris(qrisId: string) {
    const qris = await this.getQris(qrisId);
    if (qris.status !== 'PAID') return { skipped: true };
    await this.db.qrisPayment.update({ where: { id: qrisId }, data: { status: 'SETTLED' } });
    return { message: 'Settlement selesai', data: await this.getQris(qrisId) };
  }

  // Inquiry tagihan: inquiry idempotent — inquiryKey unik sama menghasilkan
  // response tak berubah sampai dibayar.
  async billInquiry(userId: string, provider: 'PLN' | 'PULSA' | 'DATA', number: string): Promise<InquiryInfo> {
    if (!['PLN', 'PULSA', 'DATA'].includes(provider)) throw new BadRequestException('Provider harus PLN, PULSA, atau DATA');
    const numberStr = String(number ?? '').trim();
    if (!numberStr) throw new BadRequestException('Nomor pelanggan wajib diisi');
    const mode = providerMode('BILL');
    if (mode === 'timeout') throw new DomainError('PROVIDER_TIMEOUT', 'Provider tidak merespons, coba lagi nanti', 504 as never);
    if (mode === 'fail') throw new DomainError('PROVIDER_FAIL', `Nomor ${numberStr} tidak terdaftar di ${provider}`);
    const inquiryKey = `${provider}:${numberStr}:${userId}`;
    const pending = await this.db.bill.findUnique({ where: { inquiryKey } });
    if (pending && pending.status === 'PENDING') {
      return {
        inquiryId: pending.id,
        provider: pending.provider,
        number: pending.number,
        customerName: 'PELANGGAN-STUB',
        amount: pending.amount,
        adminFee: 2_500,
      };
    }
    const amount = 50_000 + numberStr.length * 10_000;
    const bill = await this.db.bill.create({
      data: { userId, provider, number: numberStr, amount, inquiryKey, status: 'PENDING' },
    });
    return {
      inquiryId: bill.id,
      provider,
      number: numberStr,
      customerName: 'PELANGGAN-STUB',
      amount,
      adminFee: 2_500,
    };
  }

  // Biaya admin simulasi tetap 2.500.
  // Bayar tagihan pakai saldo ATAU paylater (tenor 1 = jatuh tempo 30 hari).
  async payBill(userId: string, inquiryId: string, method: 'BALANCE' | 'PAYLATER', idempotencyKey: string) {
    const bill = await this.db.bill.findUnique({ where: { id: inquiryId } });
    if (!bill) throw new DomainError('BILL_NOT_FOUND', 'Inquiry tagihan tidak ditemukan');
    if (bill.status !== 'PENDING') throw new DomainError('BILL_PAID', 'Tagihan sudah dibayar');
    const total = bill.amount + 2_500;
    if (method === 'BALANCE') {
      const account = await this.store.ensureAccount(userId);
      const res = await this.store.applyTransaction({
        idempotencyKey,
        kind: 'BILL',
        userId,
        counterparty: bill.provider,
        debits: [{ accountId: account, amount: total }],
        credits: [await this.store.ensureAccount('bill-provider-treasury')],
      });
      await this.db.bill.update({ where: { id: bill.id }, data: { status: 'PAID', transactionId: res.transactionId } });
      return { message: 'Tagihan berhasil dibayar dari saldo', data: { billId: bill.id, total, transactionId: res.transactionId, replay: !res.created } };
    }
    const line = await this.db.payLaterLine.findUnique({ where: { userId } });
    if (!line?.activated) throw new DomainError('PAYLATER_NOT_ACTIVE', 'PayLater belum aktif');
    if (line.used + total > line.limitAmount) throw new DomainError('LIMIT_EXCEEDED', 'Limit PayLater tidak mencukupi');
    const payLaterTx = await this.db.payLaterTx.create({
      data: {
        lineId: line.id,
        amount: total,
        totalAmount: total,
        totalInterest: 0,
        tenorMonths: 1,
        idempotencyKey,
      },
    });
    await this.db.payLaterInstallment.create({
      data: {
        payLaterTxId: payLaterTx.id,
        seq: 1,
        dueAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        amount: total,
      },
    });
    await this.db.payLaterLine.update({ where: { id: line.id }, data: { used: { increment: total } } });
    await this.db.bill.update({ where: { id: bill.id }, data: { status: 'PAID', transactionId: payLaterTx.id } });
    return { message: 'Tagihan dibayar dari PayLater, jatuh tempo 30 hari', data: { billId: bill.id, total, payLaterTxId: payLaterTx.id } };
  }

  async billStatusOf(tid: string) {
    return this.store.getTransactionByTid(tid);
  }
}

// helper untuk DomainError yang butuh status HTTP 504
declare module '../common/errors' {}
