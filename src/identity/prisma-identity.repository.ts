import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { IdentityRepository, OtpRecord, UserRecord } from './identity.repository';

@Injectable()
export class PrismaIdentityRepository implements IdentityRepository {
  constructor(private readonly db: PrismaService) {}

  private toRec(u: {
    id: string; phone: string; name: string; status: string; pinHash: string | null; failedPinAttempts: number;
  }): UserRecord {
    return { ...u, status: u.status as UserRecord['status'] };
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const u = await this.db.user.findUnique({ where: { id } });
    return u ? this.toRec(u) : null;
  }
  async findUserByPhone(phone: string): Promise<UserRecord | null> {
    const u = await this.db.user.findUnique({ where: { phone } });
    return u ? this.toRec(u) : null;
  }
  async createUser(data: { phone: string; name: string }): Promise<UserRecord> {
    return this.toRec(await this.db.user.create({ data }));
  }
  async updateUser(id: string, patch: Partial<UserRecord>): Promise<UserRecord> {
    return this.toRec(await this.db.user.update({ where: { id }, data: patch }));
  }
  async createLoginAttempt(data: { userId: string; success: boolean; reason?: string }): Promise<void> {
    await this.db.loginAttempt.create({ data });
  }
  async createOtp(code: { userId: string; codeHash: string; purpose: string; expiresAt: Date }): Promise<OtpRecord> {
    return this.db.otpCode.create({ data: code });
  }
  async latestOtp(userId: string, purpose: string): Promise<OtpRecord | null> {
    const list = await this.db.otpCode.findMany({
      where: { userId, purpose },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    return list[0] ?? null;
  }
  async consumeOtp(otpId: string): Promise<void> {
    await this.db.otpCode.update({ where: { id: otpId }, data: { consumedAt: new Date() } });
  }
  async countOtpInWindow(userId: string, purpose: string, since: Date): Promise<number> {
    return this.db.otpCode.count({ where: { userId, purpose, createdAt: { gt: since } } });
  }
}
