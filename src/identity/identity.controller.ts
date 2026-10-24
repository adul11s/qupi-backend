import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { PrismaService } from '../common/prisma.service';

@Controller('identity')
export class IdentityController {
  constructor(
    private readonly identity: IdentityService,
    private readonly db: PrismaService,
  ) {}

  @Post('register')
  async register(@Body() body: { phone: string; name: string }) {
    const user = await this.identity.register(body.phone, body.name);
    return { message: 'Registrasi berhasil', data: user };
  }

  @Post(':id/otp/request')
  async requestOtp(@Param('id') id: string, @Body() body: { purpose?: string }) {
    const res = await this.identity.requestOtp(id, body?.purpose ?? 'LOGIN');
    return { message: `OTP dikirim, berlaku ${res.expiresInMinutes} menit`, otp: res.otp };
  }

  @Post(':id/otp/verify')
  async verifyOtp(@Param('id') id: string, @Body() body: { purpose?: string; code: string }) {
    try {
      await this.identity.verifyOtp(id, body.purpose ?? 'LOGIN', body.code);
    } catch {
      return { success: false, message: 'Verifikasi OTP gagal' };
    }
    return { success: true, message: 'OTP terverifikasi' };
  }

  @Post(':id/pin')
  async setPin(@Param('id') id: string, @Body() body: { pin: string }) {
    await this.identity.setPin(id, body.pin);
    return { message: 'PIN berhasil disimpan' };
  }

  @Post(':id/login')
  async login(@Param('id') id: string, @Body() body: { pin: string }) {
    const user = await this.identity.verifyPinAndLogin(id, body.pin);
    return { message: `Selamat datang, ${user.name}`, data: { id: user.id } };
  }

  @Get(':id')
  async find(@Param('id') id: string) {
    return { data: await this.db.user.findUnique({ where: { id } }) };
  }
}
