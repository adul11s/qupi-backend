import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { IdentityRepository, UserRecord } from './identity.repository';

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
  async createOtp(_code: { userId: string; codeHash: string; purpose: string; expiresAt: Date }): Promise<never> {
    throw new Error('implementasi penuh OTP via Prisma dibuat pada task berikutnya');
  }
  async latestOtp(_userId: string, _purpose: string): Promise<null> {
    return null;
  }
  async consumeOtp(_otpId: string): Promise<void> {}
}
