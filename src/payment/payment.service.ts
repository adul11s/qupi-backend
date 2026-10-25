import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { WALLET_STORE, WalletService } from '../wallet/wallet.service';
import { WalletStore } from '../wallet/wallet.store';
import { DomainError } from '../common/errors';
import { opts, providerMode } from '../common/config';
import { QueueService } from '../queue/queue.service';
import { makeFingerprint } from '../common/idempotency';
import { assertDti } from '../common/dti';

export interface InquiryInfo {
  inquiryId: string;
  provider: string;
  number: string;
  customerName: string;
  amount: number;
  adminFee: number;
}

export interface QrisPayResult {
  message: string;
  data: Record<string, unknown>;
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

  // Fase kritis #3 (IDOR): GET qris hanya untuk owner.
  async getQrisOwned(userId: string, id: string) {
    const q = await this.getQris(id);
    if (q.userId !== userId) throw new ForbiddenException('QRIS bukan milik akun ini (FORBIDDEN)');
    return q;
  }

  // Fase kritis #6: SATU bayar QRIS — BALANCE dari saldo; PAYLATER single-debit
  // (pin verifikasi di controller). PAYLATER sinkron dalam satu operasi:
  // cek limit -> paylaterTx -> cicilan -> tandai QRIS PAID, TIDAK debit saldo.
  async qrisPay(
    userId: string,
    qrisId: string,
    o: { method: 'BALANCE' | 'PAYLATER'; idempotencyKey: string; tenorMonths?: number },
  ): Promise<QrisPayResult> {
    const qris = await this.getQris(qrisId);
    if (qris.userId !== userId) throw new ForbiddenException('QRIS bukan milik akun ini (FORBIDDEN)');
    if (qris.status !== 'PENDING') throw new DomainError('QRIS_USED', 'QRIS sudah dipakai');
    if (Date.now() > qris.expiresAt.getTime()) {
      throw new DomainError('QRIS_EXPIRED', 'QRIS kedaluwarsa (checkout melebihi 30 detik)');
    }
    if (o.method === 'BALANCE') {
      // Fase-2 #3: claim kondisional PENDING->PAID atomik — bayar dobel → 400
      // QRIS_USED sebelum犹 debit mana pun; gagal debit → claim dibatalkan.
      const claim = await this.db.qrisPayment.updateMany({
        where: { id: qrisId, status: 'PENDING' },
        data: { status: 'PAID' },
      });
      if (claim.count === 0) throw new DomainError('QRIS_USED', 'QRIS sudah dipakai', 400 as never);
      let tx: Awaited<ReturnType<typeof this.wallet.transferInternal>>;
      try {
        tx = await this.wallet.transferInternal(userId, qris.merchantId, qris.amount, o.idempotencyKey);
      } catch (e) {
        await this.db.qrisPayment.updateMany({ where: { id: qrisId, status: 'PAID' }, data: { status: 'PENDING' } });
        throw e;
      }
      this.queue.enqueue('settlement', { qrisId });
      return { message: 'QRIS berhasil dibayar dari saldo', data: { qris, transaction: tx } };
    }

    // --- PAYLATER: satu blok transaksi atomik ---
    const tenorMonths = o.tenorMonths ?? 1;
    if (![1, 3, 6].includes(tenorMonths)) throw new DomainError('TENOR_INVALID', 'Tenor harus 1, 3, atau 6 bulan');
    const line = await this.db.payLaterLine.findUnique({ where: { userId } });
    if (!line?.activated) throw new DomainError('PAYLATER_NOT_ACTIVE', 'PayLater belum aktif');
    // Fase-3 #2: fingerprint QRIS-paylater = user+nominal+qris yang dibayar.
    const fingerprint = makeFingerprint(userId, 'QRIS_PAYLATER', qris.amount, qrisId);
    const totalInterest = tenorMonths === 1 ? 0 : Math.round((qris.amount * tenorMonths) / 100); // 1% per bulan utk tenor >1
    const totalAmount = qris.amount + totalInterest;
    const payLaterTxId = await this.db.$transaction(async (tx): Promise<string> => {
      const existing = await tx.payLaterTx.findUnique({ where: { idempotencyKey: o.idempotencyKey } });
      if (existing) {
        // Fase-3 #2: key sama tapi payload beda → 409, jangan replay salah.
        if (!existing.fingerprint || existing.fingerprint !== fingerprint) {
          throw new DomainError('IDEM_CONFLICT', 'Idempotency key dipakai untuk request berbeda (fingerprint tidak cocok)', 409 as never);
        }
        return existing.id;
      }
      // Fase-3 #5: DTI juga di QRIS PayLater — cicilan/bulan ≤ 25% penghasilan.
      const freshUser = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      assertDti(freshUser.monthlyIncome, Math.round(totalAmount / tenorMonths));
      // Fase-3 #4: guard limit KONDISIONAL di dalam transaksi yang sama
      // (bukan cek-then-write di luar) — okeelah race paralel tetap aman.
      const upd = await tx.payLaterLine.updateMany({
        where: { id: line.id, used: { lte: line.limitAmount - qris.amount } },
        data: { used: { increment: qris.amount } },
      });
      if (upd.count === 0) throw new DomainError('LIMIT_EXCEEDED', 'Limit PayLater tidak mencukupi');
      // Fase-2 #3: guard kondisional QRIS di dalam transaksi RBM yang sama.
      const claim = await tx.qrisPayment.updateMany({ where: { id: qrisId, status: 'PENDING' }, data: { status: 'PAID' } });
      if (claim.count === 0) throw new DomainError('QRIS_USED', 'QRIS sudah dipakai', 400 as never);
      const pl = await tx.payLaterTx.create({
        data: { lineId: line.id, amount: qris.amount, totalAmount, totalInterest, tenorMonths, idempotencyKey: o.idempotencyKey, fingerprint },
      });
      const per = Math.round(totalAmount / tenorMonths);
      for (let seq = 1; seq <= tenorMonths; seq++) {
        await tx.payLaterInstallment.create({
          data: {
            payLaterTxId: pl.id,
            seq,
            amount: seq === tenorMonths ? totalAmount - per * (tenorMonths - 1) : per,
            dueAt: new Date(Date.now() + seq * 30 * 24 * 3600 * 1000),
          },
        });
      }
      await tx.qrisPayment.update({ where: { id: qrisId }, data: { status: 'PAID' } });
      return pl.id;
    });
    this.queue.enqueue('settlement', { qrisId });
    return {
      message: `QRIS dibayar via PayLater (single debit, ${tenorMonths}x cicilan), saldo TIDAK tersentuh`,
      data: { qrisId, payLaterTxId, paidWith: 'PAYLATER', totalAmount, totalInterest },
    };
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
    const toInquiry = (b: { id: string; provider: string; number: string; amount: number }, status: string) => ({
      inquiryId: b.id,
      provider: b.provider,
      number: b.number,
      customerName: 'PELANGGAN-STUB',
      amount: b.amount,
      adminFee: 2_500,
      status,
    });
    const pending = await this.db.bill.findUnique({ where: { inquiryKey } });
    if (pending) {
      // Fase-2 #4: inquiry ulang atas tagihan yang SUDAH LUNAS tetap mengembalikan
      // inquiry yang sama dengan status LUNAS — bukan 500 dari UNIK inquiryKey.
      if (pending.status === 'PENDING') return toInquiry(pending, 'PENDING');
      return toInquiry(pending, 'LUNAS');
    }
    const amount = 50_000 + numberStr.length * 10_000;
    let bill;
    try {
      bill = await this.db.bill.create({
        data: { userId, provider, number: numberStr, amount, inquiryKey, status: 'PENDING' },
      });
    } catch (e: unknown) {
      // Race: inquiry paralel dengan key sama → ambil baris yang sudah ada.
      if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002') {
        bill = await this.db.bill.findUnique({ where: { inquiryKey } });
        if (bill) return toInquiry(bill, bill.status === 'PENDING' ? 'PENDING' : 'LUNAS');
      }
      throw e;
    }
    return toInquiry(bill, 'PENDING');
  }

  // Biaya admin simulasi tetap 2.500.
  // Bayar tagihan pakai saldo ATAU paylater (tenor 1 = jatuh tempo 30 hari).
  async payBill(userId: string, inquiryId: string, method: 'BALANCE' | 'PAYLATER', idempotencyKey: string) {
    const bill = await this.db.bill.findUnique({ where: { id: inquiryId } });
    if (!bill) throw new DomainError('BILL_NOT_FOUND', 'Inquiry tagihan tidak ditemukan');
    if (bill.userId !== userId) throw new DomainError('FORBIDDEN', 'Tagihan bukan milik akun ini', 403 as never);
    if (bill.status !== 'PENDING') throw new DomainError('BILL_PAID', 'Tagihan sudah dibayar', 400 as never);
    const total = bill.amount + 2_500;
    // Fase-3 #2: fingerprint BILL = user+total+inquiryId yang dibayar.
    const fingerprint = makeFingerprint(userId, 'BILL', total, bill.id);
    // Fase-2 #3: claim kondisional PENDING->PAID atomik — bayar dobel → 400.
    const claim = await this.db.bill.updateMany({
      where: { id: bill.id, status: 'PENDING' },
      data: { status: 'PAID' },
    });
    if (claim.count === 0) throw new DomainError('BILL_PAID', 'Tagihan sudah dibayar', 400 as never);
    try {
      if (method === 'BALANCE') {
        const account = await this.store.ensureAccount(userId);
        const res = await this.store.applyTransaction({
          idempotencyKey,
          kind: 'BILL',
          userId,
          counterparty: bill.provider,
          fingerprint,
          debits: [{ accountId: account, amount: total }],
          credits: [await this.store.ensureAccount('bill-provider-treasury')],
        });
        await this.db.bill.update({ where: { id: bill.id }, data: { status: 'PAID', transactionId: res.transactionId } });
        return { message: 'Tagihan berhasil dibayar dari saldo', data: { billId: bill.id, total, transactionId: res.transactionId, replay: !res.created } };
      }
      const line = await this.db.payLaterLine.findUnique({ where: { userId } });
      if (!line?.activated) throw new DomainError('PAYLATER_NOT_ACTIVE', 'PayLater belum aktif');
      // Fase-3 #2/#4: fingerprint BILL-paylater + guard limit kondisional + DTI.
      const fingerprintPl = makeFingerprint(userId, 'BILL_PAYLATER', total, bill.id);
      // Fase-2 #3: cek limit + buat cicilan DALAM SATU transaksi (atom).
      const payLaterTx = await this.db.$transaction(async (tx): Promise<{ id: string }> => {
        const upd = await tx.payLaterLine.updateMany({
          where: { id: line.id, used: { lte: line.limitAmount - total } },
          data: { used: { increment: total } },
        });
        if (upd.count === 0) throw new DomainError('LIMIT_EXCEEDED', 'Limit PayLater tidak mencukupi');
        const existing = await tx.payLaterTx.findUnique({ where: { idempotencyKey } });
        if (existing) {
          // Fase-3 #2: key sama tapi payload beda → 409, jangan tandai lunas tagihan lain.
          if (!existing.fingerprint || existing.fingerprint !== fingerprintPl) {
            throw new DomainError('IDEM_CONFLICT', 'Idempotency key dipakai untuk request berbeda (fingerprint tidak cocok)', 409 as never);
          }
          return { id: existing.id };
        }
        const freshUser = await tx.user.findUniqueOrThrow({ where: { id: userId } });
        assertDti(freshUser.monthlyIncome, total);
        const pl = await tx.payLaterTx.create({
          data: {
            lineId: line.id,
            amount: total,
            totalAmount: total,
            totalInterest: 0,
            tenorMonths: 1,
            idempotencyKey,
            fingerprint: fingerprintPl,
          },
        });
        await tx.payLaterInstallment.create({
          data: {
            payLaterTxId: pl.id,
            seq: 1,
            dueAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
            amount: total,
          },
        });
        return { id: pl.id };
      });
      await this.db.bill.update({ where: { id: bill.id }, data: { status: 'PAID', transactionId: payLaterTx.id } });
      return { message: 'Tagihan dibayar dari PayLater, jatuh tempo 30 hari', data: { billId: bill.id, total, payLaterTxId: payLaterTx.id } };
    } catch (e: unknown) {
      // Debit gagal (mis. saldo kurang) → bill dikembalikan PENDING, tidak stuck PAID.
      // Debit gagal (saldo kurang / P2002 race) → bill kembali PENDING.
      await this.db.bill.updateMany({ where: { id: bill.id, status: 'PAID', transactionId: null }, data: { status: 'PENDING' } });
      throw e;
    }
  }

  async billStatusOf(tid: string) {
    return this.store.getTransactionByTid(tid);
  }
}

// helper untuk DomainError yang butuh status HTTP 504
declare module '../common/errors' {}
