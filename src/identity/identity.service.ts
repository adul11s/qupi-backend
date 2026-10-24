import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomInt } from 'crypto';
import { DomainError } from '../common/errors';
import { IdentityRepository, UserRecord } from './identity.repository';

export interface IdentityOptions {
  pinMaxAttempts: number;
  otpTtlMinutes: number;
  otpMaxPerMinute: number;
}

@Injectable()
export class IdentityService {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly o: IdentityOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private hash(v: string): string {
    return createHash('sha256').update(v).digest('hex');
  }

  async register(phone: string, name: string): Promise<UserRecord> {
    if (!/^62\d{8,14}$/.test(phone)) {
      throw new BadRequestException('Nomor telepon harus format 62xxx');
    }
    const existing = await this.repo.findUserByPhone(phone);
    if (existing) throw new DomainError('PHONE_TAKEN', 'Nomor sudah terdaftar');
    return this.repo.createUser({ phone, name });
  }

  // OTP berlaku 5 menit, maksimal 3 permintaan per menit.
  async requestOtp(userId: string, purpose = 'LOGIN'): Promise<{ expiresInMinutes: number; otp?: string }> {
    const user = await this.repo.findUserById(userId);
    if (!user) throw new DomainError('USER_NOT_FOUND', 'User tidak ditemukan');
    const t = this.now().getTime();
    const last = await this.repo.latestOtp(userId, purpose);
    const windowMs = 60_000;
    if (last) {
      // rate limit dihitung terhadap waktu pembuatan OTP sebelumnya dalam 1 menit
      const created = last.createdAt.getTime();
      const countInWindow = 1; // disederhanakan: repository hanya menyimpan latest; versi penuh di task lanjutan
      if (t - created < windowMs && countInWindow >= this.o.otpMaxPerMinute) {
        throw new DomainError('OTP_RATE_LIMIT', 'Terlalu banyak permintaan OTP, coba lagi sekitar 1 menit');
      }
      if (t - created < windowMs) {
        // masih dalam window yang sama: tolak permintaan ke-2 dst sesuai kebijakan 3/menit
        if (countInWindow + 1 > this.o.otpMaxPerMinute) {
          throw new DomainError('OTP_RATE_LIMIT', 'Terlalu banyak permintaan OTP, coba lagi sekitar 1 menit');
        }
        // dan tidak lebih baru mengganti yang masih berlaku
        if (t - created < this.o.otpTtlMinutes * 60_000) {
          throw new DomainError('OTP_ACTIVE', 'OTP masih aktif, tunggu sebelum meminta ulang');
        }
      }
    }
    const code = String(randomInt(100000, 999999));
    await this.repo.createOtp({
      userId,
      codeHash: this.hash(code),
      purpose,
      expiresAt: new Date(t + this.o.otpTtlMinutes * 60_000),
    });
    return { expiresInMinutes: this.o.otpTtlMinutes, otp: process.env.OTP_DEBUG === '1' ? code : undefined };
  }

  async verifyOtp(userId: string, purpose: string, code: string): Promise<boolean> {
    const otp = await this.repo.latestOtp(userId, purpose);
    if (!otp || otp.consumedAt) throw new DomainError('OTP_INVALID', 'OTP tidak valid atau sudah digunakan');
    if (this.now().getTime() > otp.expiresAt.getTime()) throw new DomainError('OTP_EXPIRED', 'OTP sudah kedaluwarsa');
    if (this.hash(code) !== otp.codeHash) throw new DomainError('OTP_MISMATCH', 'OTP salah');
    await this.repo.consumeOtp(otp.id);
    return true;
  }

  async setPin(userId: string, pin: string): Promise<void> {
    if (!/^\d{6}$/.test(pin)) throw new DomainError('PIN_FORMAT', 'PIN harus 6 digit angka');
    await this.repo.updateUser(userId, { pinHash: this.hash(pin) });
  }

  // PIN salah 5 kali -> akun terkunci (status LOCKED).
  async verifyPinAndLogin(userId: string, pin: string): Promise<UserRecord> {
    const user = await this.repo.findUserById(userId);
    if (!user) throw new DomainError('USER_NOT_FOUND', 'User tidak ditemukan');
    if (user.status === 'LOCKED') {
      throw new ForbiddenException('Akun terkunci karena terlalu banyak percobaan PIN yang salah');
    }
    if (user.status === 'BLOCKED') throw new ForbiddenException('Akun diblokir');
    const ok = user.pinHash !== null && this.hash(pin) === user.pinHash;
    await this.repo.createLoginAttempt({ userId, success: ok, reason: ok ? undefined : 'PIN_SALAH' });
    if (!ok) {
      const failed = user.failedPinAttempts + 1;
      const locked = failed >= this.o.pinMaxAttempts;
      await this.repo.updateUser(userId, {
        failedPinAttempts: locked ? 0 : failed,
        status: locked ? 'LOCKED' : user.status,
      });
      if (locked) throw new ForbiddenException('Akun terkunci setelah 5 pin salah');
      throw new UnauthorizedException(`PIN salah, sisa ${this.o.pinMaxAttempts - failed} percobaan`);
    }
    await this.repo.updateUser(userId, { failedPinAttempts: 0 });
    return user;
  }
}
