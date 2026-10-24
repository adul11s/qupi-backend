import { UserStatus } from '@prisma/client';

// Record domain (tidak langsung model Prisma) supaya adapter Prisma maupun
// in-memory memakai kontrak yang sama.
export type UserStatusT = 'ACTIVE' | 'BLOCKED' | 'LOCKED';

export interface UserRecord {
  id: string;
  phone: string;
  name: string;
  status: UserStatusT | UserStatus;
  pinHash: string | null;
  failedPinAttempts: number;
}

export interface OtpRecord {
  id: string;
  userId: string;
  codeHash: string;
  purpose: string;
  expiresAt: Date;
  createdAt: Date;
  consumedAt: Date | null;
}

export interface IdentityRepository {
  findUserById(id: string): Promise<UserRecord | null>;
  findUserByPhone(phone: string): Promise<UserRecord | null>;
  createUser(data: { phone: string; name: string }): Promise<UserRecord>;
  updateUser(id: string, patch: Partial<UserRecord>): Promise<UserRecord>;
  createLoginAttempt(data: { userId: string; success: boolean; reason?: string }): Promise<void>;
  createOtp(code: { userId: string; codeHash: string; purpose: string; expiresAt: Date }): Promise<OtpRecord>;
  latestOtp(userId: string, purpose: string): Promise<OtpRecord | null>;
  consumeOtp(otpId: string): Promise<void>;
}
