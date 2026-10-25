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
