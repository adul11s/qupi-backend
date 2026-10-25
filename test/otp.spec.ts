import { IdentityService } from '../src/identity/identity.service';
import { InMemoryIdentityRepository } from '../src/identity/in-memory-identity.repository';
import { DomainError } from '../src/common/errors';

const FIXED = new Date('2026-01-01T00:00:00Z');
const nowMs = FIXED.getTime();

describe('Identity: OTP kadaluarsa & rate limit', () => {
  const repo = new InMemoryIdentityRepository();
  let svc: IdentityService;
  beforeAll(async () => {
    const clock = () => new Date(nowMs);
    svc = new IdentityService(repo, { pinMaxAttempts: 5, otpTtlMinutes: 5, otpMaxPerMinute: 3 }, clock);
    await svc.register('62899999999', 'Citra');
    const u = await repo.findUserByPhone('62899999999');
    const r1 = await svc.requestOtp(u!.id);
    expect(r1.expiresInMinutes).toBe(5);
  });

  it('OTP sama masih aktif di jendela 1 menit menolak pemintaan ulang', async () => {
    const u = await repo.findUserByPhone('62899999999');
    await expect(svc.requestOtp(u!.id)).rejects.toThrow(DomainError);
  });

  it('OTP salah kode ditolak', async () => {
    const u = await repo.findUserByPhone('62899999999');
    await expect(svc.verifyOtp(u!.id, 'LOGIN', '000000')).rejects.toThrow('OTP salah');
  });
});
