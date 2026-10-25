import { IdentityRepository, OtpRecord, UserRecord } from './identity.repository';

// Adapter in-memory untuk unit test tanpa Postgres — kode service yang sama.
let seq = 0;
export class InMemoryIdentityRepository implements IdentityRepository {
  users: UserRecord[] = [];
  otps: OtpRecord[] = [];
  attempts: { userId: string; success: boolean; reason?: string; createdAt: Date }[] = [];

  private nid(): string {
    seq += 1;
    return `n${seq}`;
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    return this.users.find((u) => u.id === id) ?? null;
  }
  async findUserByPhone(phone: string): Promise<UserRecord | null> {
    return this.users.find((u) => u.phone === phone) ?? null;
  }
  async createUser(data: { phone: string; name: string }): Promise<UserRecord> {
    const u: UserRecord = {
      id: this.nid(),
      phone: data.phone,
      name: data.name,
      status: 'ACTIVE',
      pinHash: null,
      failedPinAttempts: 0,
    };
    this.users.push(u);
    return u;
  }
  async updateUser(id: string, patch: Partial<UserRecord>): Promise<UserRecord> {
    const u = this.users.find((x) => x.id === id);
    if (!u) throw new Error('user tidak ditemukan');
    Object.assign(u, patch);
    return u;
  }
  async createLoginAttempt(data: { userId: string; success: boolean; reason?: string }): Promise<void> {
    this.attempts.push({ ...data, createdAt: new Date() });
  }
  async createOtp(code: { userId: string; codeHash: string; purpose: string; expiresAt: Date }): Promise<OtpRecord> {
    const o: OtpRecord = { id: this.nid(), createdAt: new Date(), verifiedAt: null, ...code };
    this.otps.push(o);
    return o;
  }
  async latestOtp(userId: string, purpose: string): Promise<OtpRecord | null> {
    const list = this.otps
      .filter((o) => o.userId === userId && o.purpose === purpose)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return list[0] ?? null;
  }
  async consumeOtp(otpId: string): Promise<void> {
    const o = this.otps.find((x) => x.id === otpId);
    if (o) o.verifiedAt = new Date();
  }
  async countOtpInWindow(userId: string, purpose: string, since: Date): Promise<number> {
    return this.otps.filter(
      (o) => o.userId === userId && o.purpose === purpose && o.createdAt >= since && o.verifiedAt === null,
    ).length;
  }
}
