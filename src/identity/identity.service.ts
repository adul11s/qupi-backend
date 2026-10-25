import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomInt } from 'crypto';
import { DomainError } from '../common/errors';
import { IdentityRepository, OtpRecord, UserRecord } from './identity.repository';

export interface IdentityOptions {
  pinMaxAttempts: number;
  otpTtlMinutes: number;
  otpMaxPerMinute: number;
}

// OTP terverifikasi membusuk setelah 5 menit — bukti lama tidak dianggap valid.
function throwIfStale(otp: OtpRecord, now: () => Date): void {
  const verifiedAt = otp.verifiedAt as Date | null;
  if (!verifiedAt) return;
  const ageMs = now().getTime() - verifiedAt.getTime();
  if (ageMs > 5 * 60_000) throw new DomainError('OTP_PROOF_STALE', 'Bukti OTP sudah lewat 5 menit, minta OTP baru');
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
    if (!/^62\d{8,14}$/.test(phone)) throw new BadRequestException('Nomor HP harus format E164 Indonesia (62xxx)');
    if (!name || name.trim().length < 2) throw new BadRequestException('Nama minimal 2 karakter');
    const existing = await this.repo.findUserByPhone(phone);
    if (existing) throw new DomainError('PHONE_TAKEN', 'Nomor HP sudah terdaftar');
    return this.repo.createUser({ phone, name: name.trim() });
  }

  // Untuk lookup penerima transfer (controller /lookup).
  async byPhone(phone: string): Promise<UserRecord> {
    return (await this.repo.findUserByPhone(phone)) as UserRecord;
  }

  // OTP berlaku 5 menit, maksimal 3 permintaan per menit (hitung OTP baru
  // dalam jendela 60 detik, tanpa pedoman sekadar "terakhir").
  async requestOtp(userId: string, purpose = 'LOGIN'): Promise<{ expiresInMinutes: number; otp?: string }> {
    const user = await this.repo.findUserById(userId);
    if (!user) throw new DomainError('USER_NOT_FOUND', 'User tidak ditemukan');
    const t = this.now().getTime();
    const windowStart = new Date(t - 60_000);
    const recent = await this.repo.countOtpInWindow(userId, purpose, windowStart);
    if (recent >= this.o.otpMaxPerMinute) {
      throw new DomainError('OTP_RATE_LIMIT', 'Terlalu banyak permintaan OTP, coba lagi dalam 1 menit');
    }
    const last = await this.repo.latestOtp(userId, purpose);
    if (last && !last.verifiedAt && t < last.expiresAt.getTime()) {
      throw new DomainError('OTP_ACTIVE', 'OTP masih aktif, silakan dipakai atau tunggu kedaluwarsa');
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
    if (!otp || otp.verifiedAt) throw new DomainError('OTP_INVALID', 'OTP tidak valid atau sudah dipakai');
    if (this.now().getTime() > otp.expiresAt.getTime()) throw new DomainError('OTP_EXPIRED', 'OTP sudah kedaluwarsa');
    if (this.hash(code) !== otp.codeHash) throw new DomainError('OTP_MISMATCH', 'OTP salah');
    await this.repo.consumeOtp(otp.id);
    return true;
  }

  async requestOtpByPhone(phone: string, purpose: string) {
    const user = await this.repo.findUserByPhone(phone);
    if (!user) throw new DomainError('USER_NOT_FOUND', 'User tidak ditemukan');
    return this.requestOtp(user.id, purpose);
  }

  async setPin(userId: string, pin: string, requireExisting = false): Promise<void> {
    if (!/^\d{6}$/.test(pin)) throw new DomainError('PIN_FORMAT', 'PIN harus 6 digit angka');
    if (requireExisting) {
      const u = await this.repo.findUserById(userId);
      if (!u?.pinHash) throw new DomainError('PIN_NOT_SET', 'PIN belum pernah diset');
    }
    await this.repo.updateUser(userId, { pinHash: this.hash(pin) });
  }

  // Fase kritis: set PIN wajib bukti OTP terverifikasi (purpose RESET_PIN atau
  // LOGIN). SET awal (belum punya PIN): RESET_PIN atau LOGIN. RESET (sudah punya
  // PIN): wajib OTP RESET_PIN baru setelah PIN lama terverifikasi di server.
  async setPinWithOtpProof(userId: string, pin: string, requireExisting = false): Promise<void> {
    if (!/^\d{6}$/.test(pin)) throw new DomainError('PIN_FORMAT', 'PIN harus 6 digit angka');
    const user = await this.repo.findUserById(userId);
    if (!user) throw new DomainError('USER_NOT_FOUND', 'User tidak ditemukan');
    if (requireExisting || user.pinHash) {
      // Reset konteks: OTP RESET_PIN yang TERBARU harus terverifikasi segar (5 menit).
      const otp = await this.repo.latestOtp(userId, 'RESET_PIN');
      if (!otp?.verifiedAt) throw new DomainError('OTP_PROOF_REQUIRED', 'Reset PIN wajib verifikasi OTP purpose RESET_PIN dulu');
      throwIfStale(otp, this.now);
    } else {
      // Set awal: bukti OTP LOGIN atau RESET_PIN terverifikasi dalam 5 menit.
      const login = await this.repo.latestOtp(userId, 'LOGIN');
      const reset = await this.repo.latestOtp(userId, 'RESET_PIN');
      const fresh = [login, reset].find((o) => o?.verifiedAt);
      if (!fresh) throw new DomainError('OTP_PROOF_REQUIRED', 'Set PIN wajib verifikasi OTP (LOGIN atau RESET_PIN) dulu');
      throwIfStale(fresh, this.now);
    }
    await this.repo.updateUser(userId, { pinHash: this.hash(pin) });
  }

  async verifyPinAndLogin(userId: string, pin: string): Promise<{ user: UserRecord }> {
    const user = await this.repo.findUserById(userId);
    if (!user) throw new DomainError('USER_NOT_FOUND', 'User tidak ditemukan');
    if (user.status === 'LOCKED') {
      throw new ForbiddenException('Akun terkunci karena 5x PIN salah. Buka lewat OTP (purpose UNLOCK)');
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
      if (locked) throw new ForbiddenException('Akun terkunci setelah 5x PIN salah');
      throw new UnauthorizedException(`PIN salah, sisa ${this.o.pinMaxAttempts - failed} percobaan`);
    }
    await this.repo.updateUser(userId, { failedPinAttempts: 0 });
    return { user };
  }

  // Unlock: verifikasi OTP purpose UNLOCK lalu aktifkan lagi akun.
  async unlockWithOtp(userId: string, code: string): Promise<UserRecord> {
    await this.verifyOtp(userId, 'UNLOCK', code);
    return this.repo.updateUser(userId, { status: 'ACTIVE', failedPinAttempts: 0 });
  }

  // Lupa PIN: OTP purpose RESET_PIN, lalu PIN baru (PIN lama wajib pernah ada).
  async resetPinWithOtp(userId: string, code: string, newPin: string): Promise<void> {
    await this.verifyOtp(userId, 'RESET_PIN', code);
    await this.setPin(userId, newPin, true);
  }
}
