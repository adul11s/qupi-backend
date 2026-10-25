import { ArgumentMetadata, BadRequestException, PipeTransform } from '@nestjs/common';

// Pastikan nominal uang selalu integer rupiah positif.
export class MoneyPipe implements PipeTransform {
  transform(value: unknown, _metadata: ArgumentMetadata): number {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
      throw new BadRequestException('Nominal harus berupa integer rupiah lebih dari 0');
    }
    return n;
  }
}

// komen: pipe sederhana nominal
export class KeyPipe implements PipeTransform {
  transform(value: string, _m: ArgumentMetadata): string {
    if (!value || typeof value !== 'string' || value.length < 8) {
      throw new BadRequestException('Idempotency-Key wajib diisi (minimal 8 karakter)');
    }
    return value;
  }
}

// Fase-4 #5: nominal transfer/va wajib integer rupiah murni — token string
// "12.5", "1e9", "+123", "0x10", desimal, minus, nol, atau lewat batas safety
// 2.500.000.000 semuanya ditolak 400 INVALID_AMOUNT (bukan menyebab 500 di Prisma).
export const MAX_TRANSFER_AMOUNT = 2_500_000_000; // pilot 'dompet tanpa batas transaksi' — cap safety memori/ledger
export class AmountPipe implements PipeTransform {
  transform(value: unknown, _metadata: ArgumentMetadata): number {
    const token = typeof value === 'string' ? value : JSON.stringify(value);
    const bad = (msg: string): BadRequestException => new BadRequestException(`INVALID_AMOUNT: ${msg}`);
    if (typeof token !== 'string' || !/^\d+$/.test(token)) throw bad('nominal wajib integer rupiah positif (tanpa desimal/negatif/eksponensial)');
    const n = Number(token);
    if (!Number.isSafeInteger(n) || n <= 0) throw bad('nominal wajib di luar nol dan dalam rentang aman');
    if (n > MAX_TRANSFER_AMOUNT) throw bad(`melebihi batas safety Rp${MAX_TRANSFER_AMOUNT.toLocaleString('id-ID')}`);
    return n;
  }
}
