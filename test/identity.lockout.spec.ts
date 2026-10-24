import { IdentityService } from '../src/identity/identity.service';
import { InMemoryIdentityRepository } from '../src/identity/in-memory-identity.repository';
import { ForbiddenException } from '@nestjs/common';

describe('Identity: lockout PIN', () => {
  const svc = () => {
    const repo = new InMemoryIdentityRepository();
    const service = new IdentityService(repo, { pinMaxAttempts: 5, otpTtlMinutes: 5, otpMaxPerMinute: 3 });
    return { repo, service };
  };

  it('PIN salah 5x -> akun LOCKED', async () => {
    const { repo, service } = svc();
    const user = await service.register('628123456789', 'Andi');
    await service.setPin(user.id, '123456');

    for (let i = 1; i <= 4; i++) {
      await expect(service.verifyPinAndLogin(user.id, '000000')).rejects.toThrow();
      expect((await repo.findUserById(user.id))!.status).toBe('ACTIVE');
    }
    await expect(service.verifyPinAndLogin(user.id, '000000')).rejects.toThrow(ForbiddenException);
    expect((await repo.findUserById(user.id))!.status).toBe('LOCKED');
    // setelah terkunci, pin benar pun ditolak
    await expect(service.verifyPinAndLogin(user.id, '123456')).rejects.toThrow(ForbiddenException);
  });

  it('PIN salah 4x lalu benar -> attempts reset, tetap ACTIVE', async () => {
    const { repo, service } = svc();
    const user = await service.register('628123456790', 'Budi');
    await service.setPin(user.id, '123456');
    for (let i = 0; i < 4; i++) await expect(service.verifyPinAndLogin(user.id, '000000')).rejects.toThrow();
    await service.verifyPinAndLogin(user.id, '123456');
    expect((await repo.findUserById(user.id))!.failedPinAttempts).toBe(0);
    expect((await repo.findUserById(user.id))!.status).toBe('ACTIVE');
  });
});
