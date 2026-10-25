import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { hashSecret, verifySecret, needsMigrationToScrypt } from './hash.util';
import { PrismaService } from './prisma.service';
import { opts } from './config';

interface AttemptWindow {
  count: number;
  windowStartMs: number;
}

/**
 * Verifikasi PIN server-side wajib di setiap endpoint transaksi (fase kritis #4).
 * Simpel & konsisten: counter in-memory per user dalam jendela 1 menit.
 * Salah -> 400 PIN_SALAH; >=5 salah dalam 1 menit -> 403 PIN_LOCKED
 * (mekanisme lock setara login). Reset saat PIN benar.
 */
@Injectable()
export class PinService {
  private static WINDOW_MS = 60_000;
  private attempts = new Map<string, AttemptWindow>();
  private locks = new Map<string, Promise<unknown>>();

  constructor(private readonly db: PrismaService) {}

  private attemptCount(userId: string): number {
    const w = this.attempts.get(userId);
    if (!w) return 0;
    if (Date.now() - w.windowStartMs > PinService.WINDOW_MS) {
      this.attempts.delete(userId);
      return 0;
    }
    return w.count;
  }

  private bumpFailed(userId: string): void {
    const w = this.attempts.get(userId);
    const fresh = !w || Date.now() - w.windowStartMs > PinService.WINDOW_MS;
    this.attempts.set(userId, {
      count: fresh ? 1 : w.count + 1,
      windowStartMs: fresh ? Date.now() : w.windowStartMs,
    });
  }

  private clear(userId: string): void {
    this.attempts.delete(userId);
  }

  // Pilih antrean lock: melebihi PIN_MAX_ATTEMP lima per jendela 1 menit.
  assertFormat(pin: string): void {
    if (!/^\d{6}$/.test(String(pin ?? ''))) {
      throw new BadRequestException('PIN wajib 6 digit');
    }
  }

  async verify(userId: string, pin: string): Promise<void> {
    // Checklist 3: attempt dicek dan dicatat sinkron (check+bump atomik di satu
    // tick) supaya percobaan paralel tidak bisa menembus window lock — 8 salah paralel
    // berarti tepat 5 verifikasi diproses dan 3 sisanya langsung PIN_LOCKED 403.
    // Antrean per-user (muteks logis): check+bump+verify+clear benar-benar tiada
    // celah satu tick, dan PIN benar tak lagi memicu lock saat dibangunkan paralel
    // (50 transfer concurrent tetap lolos PIN).
    const tail = this.locks.get(userId) ?? Promise.resolve();
    const run = tail.catch(() => undefined).then(() => this.verifyLocked(userId, pin));
    this.locks.set(userId, run);
    try {
      await run;
    } finally {
      if (this.locks.get(userId) === run) this.locks.delete(userId);
    }
  }

  private async verifyLocked(userId: string, pin: string): Promise<void> {
    if (this.attemptCount(userId) >= opts().pinMaxAttempts) {
      throw new ForbiddenException('Percobaan PIN salah terlalu banyak, coba lagi dalam 1 menit (PIN_LOCKED)');
    }
    this.bumpFailed(userId);
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Sesi tidak valid');
    const ver = user.pinHash ? verifySecret(String(pin), user.pinHash) : null;
    if (ver !== true) {
      throw new BadRequestException('PIN_SALAH');
    }
    this.clear(userId);
    // Fase-2 #1: migrate hash legacy SHA-256 -> scrypt saat PIN terverifikasi.
    if (user.pinHash && needsMigrationToScrypt(user.pinHash)) {
      await this.db.user.update({ where: { id: user.id }, data: { pinHash: hashSecret(String(pin)) } });
    }
  }
}
