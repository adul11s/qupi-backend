import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomInt } from 'crypto';
import { DomainError } from '../common/errors';
import { hashSecret, verifySecret, needsMigrationToScrypt } from '../common/hash.util';
import { IdentityRepository, OtpRecord, UserRecord } from './identity.repository';

// Fase-2 #2: maksimal 5 percobaan salah per kode OTP — lebih → kode invalid.
const OTP_VERIFY_MAX_ATTEMPTS = Number(process.env.OTP_VERIFY_MAX_ATTEMPTS ?? 5);

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
  // Counter percobaan OTP salah per kode (id OTP) — in-memory, kode berumur pendek.
  private readonly otpWrong = new Map<string, number>();

  constructor(
    private readonly repo: IdentityRepository,
    private readonly o: IdentityOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // Hash PIN/OTP kini SCRYPT + salt per-record (fase-2 #1); hashSecret → verifikasi
  // via verifySecret (legacy SHA-256 masih diterima lalu dimigrasi).
  private async migrateLegacyPin(userId: string, pin: string, currentHash: string): Promise<void> {
    if (needsMigrationToScrypt(currentHash)) {
      await this.repo.updateUser(userId, { pinHash: hashSecret(pin) });
    }
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
      codeHash: hashSecret(code),
      purpose,
      expiresAt: new Date(t + this.o.otpTtlMinutes * 60_000),
    });
    return { expiresInMinutes: this.o.otpTtlMinutes, otp: process.env.OTP_DEBUG === '1' ? code : undefined };
  }

  async verifyOtp(userId: string, purpose: string, code: string): Promise<boolean> {
    const otp = await this.repo.latestOtp(userId, purpose);
    if (!otp || otp.verifiedAt) throw new DomainError('OTP_INVALID', 'OTP tidak valid atau sudah dipakai');
    if (this.now().getTime() > otp.expiresAt.getTime()) throw new DomainError('OTP_EXPIRED', 'OTP sudah kedaluwarsa');
    const ver = verifySecret(code, otp.codeHash);
    if (ver !== true) {
      const n = (this.otpWrong.get(otp.id) ?? 0) + 1;
      this.otpWrong.set(otp.id, n);
      if (n >= OTP_VERIFY_MAX_ATTEMPTS) {
        // Fase-2 #2: kode dibunuh setelah >= 5 percobaan salah → permintaan
        // berikutnya selalu OTP_INVALID walau kode aslinya benar.
        await this.repo.consumeOtp(otp.id);
        throw new DomainError('OTP_INVALID', 'OTP salah terlalu banyak, permintaan yang baru');
      }
      throw new DomainError('OTP_MISMATCH', 'OTP salah');
    }
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
    await this.repo.updateUser(userId, { pinHash: hashSecret(pin) });
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
    await this.repo.updateUser(userId, { pinHash: hashSecret(pin) });
  }

  async verifyPinAndLogin(userId: string, pin: string): Promise<{ user: UserRecord }> {
    const user = await this.repo.findUserById(userId);
    if (!user) throw new DomainError('USER_NOT_FOUND', 'User tidak ditemukan');
    if (user.status === 'LOCKED') {
      throw new ForbiddenException('Akun terkunci karena 5x PIN salah. Buka lewat OTP (purpose UNLOCK)');
    }
    if (user.status === 'BLOCKED') throw new ForbiddenException('Akun diblokir');
    const ver = user.pinHash ? verifySecret(pin, user.pinHash) : null;
    const ok = ver === true;
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
    // Fase-2 #1: PIN legacy SHA-256 dimigrasi ke scrypt otomatis saat login sukses.
    await this.migrateLegacyPin(userId, pin, user.pinHash!);
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
