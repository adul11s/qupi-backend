import { randomBytes } from 'crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { opts } from './config';
import { User } from '@prisma/client';

// Sesi idle: token mati otomatis bila tak ada aktivitas selama 15 menit.
// Refresh token menghasilkan token baru dan menonaktifkan yang lama.
@Injectable()
export class SessionService {
  private readonly idleMs = opts().sessionIdleMinutes * 60_000;

  constructor(private readonly db: PrismaService) {}

  async create(userId: string): Promise<string> {
    const token = randomBytes(24).toString('hex');
    await this.db.session.create({ data: { token, userId } });
    return token;
  }

  async validate(token: string | undefined): Promise<User> {
    if (!token) throw new UnauthorizedException('Header X-Session-Token wajib disertakan');
    const s = await this.db.session.findUnique({ where: { token }, include: { user: true } });
    if (!s || s.revokedAt) throw new UnauthorizedException('Sesi tidak valid atau sudah berakhir');
    if (Date.now() - s.lastActivityAt.getTime() > this.idleMs) {
      await this.db.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
      throw new UnauthorizedException('Sesi berakhir karena tidak ada aktivitas (idle 15 menit)');
    }
    await this.db.session.update({ where: { id: s.id }, data: { lastActivityAt: new Date() } });
    return s.user;
  }

  async revoke(token: string | undefined): Promise<void> {
    if (token) await this.db.session.updateMany({ where: { token }, data: { revokedAt: new Date() } });
  }

  // Simulasi jam untuk uji idle-timeout: mundurkan waktu aktivitas sesi.
  async advanceClock(token: string | undefined, minutes: number): Promise<void> {
    if (!token) throw new UnauthorizedException('Sesi tidak ditemukan');
    const s = await this.db.session.findUnique({ where: { token } });
    if (!s) throw new UnauthorizedException('Sesi tidak ditemukan');
    await this.db.session.update({
      where: { id: s.id },
      data: { lastActivityAt: new Date(Date.now() - minutes * 60_000) },
    });
  }
}
