import {
  Body, Controller, ForbiddenException, Get, HttpCode, Post, UnauthorizedException, Req, Query, BadRequestException, NotFoundException,
} from '@nestjs/common';
import { IdentityService } from './identity.service';
import { PrismaService } from '../common/prisma.service';
import { SessionService } from '../common/session.service';
import { Public } from '../common/session.guard';
import { Request } from 'express';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { KycStatus } from '@prisma/client';
import { reqUser } from '../common/req-user';

@Controller('identity')
export class IdentityController {
  constructor(
    private readonly identity: IdentityService,
    private readonly db: PrismaService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Post('register')
  async register(@Body() body: { phone: string; name: string }) {
    const user = await this.identity.register(body.phone, body.name);
    return { message: 'Registrasi berhasil, silakan minta OTP', data: { id: user.id, phone: user.phone } };
  }

  @Public()
  @Post('otp/request')
  async requestOtp(@Body() body: { phone?: string; userId?: string; purpose?: string }) {
    const purpose = body.purpose ?? 'LOGIN';
    const allowed = ['LOGIN', 'UNLOCK', 'RESET_PIN'];
    if (!allowed.includes(purpose)) throw new ForbiddenException('Purpose OTP tidak dikenal');
    const res = body.phone
      ? await this.identity.requestOtpByPhone(body.phone, purpose)
      : await this.identity.requestOtp(body.userId!, purpose);
    return { message: `OTP dikirim, berlaku ${res.expiresInMinutes} menit`, otp: res.otp };
  }

  @Public()
  @Post('otp/verify')
  async verifyOtp(@Body() body: { userId: string; purpose?: string; code: string }) {
    const purpose = body.purpose ?? 'LOGIN';
    const ok = await this.identity.verifyOtp(body.userId, purpose, body.code);
    // Onboarding: user baru belum punya PIN (login PIN belum bisa) — OTP sudah
    // terverifikasi, jadi buat sesi terbatas agar /identity/pin/set bisa dipakai.
    let sessionToken: string | undefined;
    if (ok) {
      const user = await this.db.user.findUnique({ where: { id: body.userId } });
      if (user && !user.pinHash) sessionToken = await this.sessions.create(user.id);
    }
    return { success: ok, message: 'OTP terverifikasi', ...(sessionToken ? { data: { sessionToken } } : {}) };
  }

  // Fase kritis #1: setPIN TIDAK publik lagi — wajib sesi + bukti OTP terverifikasi
  // (purpose LOGIN utk set awal, RESET_PIN wajib utk reset PIN user lama).
  @Post('pin/set')
  async setPin(@Req() req: Request, @Body() body: { userId?: string; pin: string }) {
    const user = reqUser(req);
    await this.identity.setPinWithOtpProof(user.id, body.pin);
    return { message: 'PIN berhasil disimpan' };
  }

  // Login PIN -> token sesi (idle 15 menit).
  @Public()
  @Post('login')
  async login(@Body() body: { userId?: string; phone?: string; pin: string }) {
    const id = body.userId ?? (body.phone ? (await this.db.user.findUnique({ where: { phone: body.phone } }))?.id : undefined);
    if (!id) throw new UnauthorizedException('User tidak ditemukan');
    const { user } = await this.identity.verifyPinAndLogin(id, body.pin);
    const token = await this.sessions.create(user.id);
    return { message: `Selamat datang, ${user.name}`, data: { userId: user.id, sessionToken: token } };
  }

  // Fase-2 #5: logout eksplisit — token direvoke server-side (tidak menunggu idle).
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request) {
    await this.sessions.revoke(req.headers['x-session-token'] as string | undefined);
    return { message: 'Logout berhasil, sesi diakhiri' };
  }

  // Flow refresh token: token baru, token lama dibatalkan.
  @Post('session/refresh')
  async refresh(@Req() req: Request) {
    const user = reqUser(req);
    await this.sessions.revoke(req.headers['x-session-token'] as string | undefined);
    const token = await this.sessions.create(user.id);
    return { message: 'Sesi diperbarui', data: { sessionToken: token } };
  }

  // Simulasi jam untuk uji idle 15 menit (mundurkan aktivitas terakhir).
  @Post('session/clock/advance')
  async advance(@Req() req: Request, @Body() body: { minutes: number }) {
    // Fase-2 #6: nilai negatif membuat sesi tak pernah idle; >180 di luar uji.
    const m = Number(body.minutes);
    if (!Number.isFinite(m) || m < 0 || m > 180) {
      throw new BadRequestException('minutes harus 0-180');
    }
    await this.sessions.advanceClock(req.headers['x-session-token'] as string | undefined, m);
    return { message: `Waktu sesi dimundurkan ${m} menit` };
  }

  @Post('unlock')
  async unlock(@Body() body: { userId: string; code: string }) {
    const user = await this.identity.unlockWithOtp(body.userId, body.code);
    return { message: 'Akun berhasil dibuka kembali', data: { status: user.status } };
  }

  @Post('pin/reset')
  async resetPin(@Body() body: { userId: string; code: string; pin: string }) {
    await this.identity.resetPinWithOtp(body.userId, body.code, body.pin);
    return { message: 'PIN berhasil direset' };
  }

  // Upload KTP (base64) — status PENDING sampai admin approve/reject.
  @Post('kyc/upload')
  async uploadKyc(@Req() req: Request, @Body() body: { kind?: string; fileName?: string; contentBase64: string }) {
    const user = reqUser(req);
    const buf = Buffer.from(body.contentBase64, 'base64');
    if (buf.byteLength === 0) throw new BadRequestLike();
    const dir = join(process.cwd(), 'uploads');
    await mkdir(dir, { recursive: true });
    const fileName = body.fileName ?? `${randomUUID()}.jpg`;
    const path = join(dir, `${randomUUID()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
    await writeFile(path, buf);
    const doc = await this.db.kycDocument.create({
      data: { userId: user.id, kind: body.kind ?? 'KTP', fileUrl: path, status: KycStatus.PENDING },
    });
    return { message: 'Dokumen KTP diunggah, menunggu verifikasi', data: doc };
  }

  @Get('kyc/documents')
  async myKyc(@Req() req: Request) {
    const user = reqUser(req);
    const docs = await this.db.kycDocument.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    return { data: docs };
  }

  // Cari user tujuan transfer (by phone) — fase-3 #6: TIDAK bocorkan nama penuh,
  // hanya id + nama ter-obfuskasi (2 karakter awal, sisanya ***).
  @Get('lookup')
  async lookup(@Query('phone') phone: string) {
    if (!phone) throw new BadRequestException('Parameter phone wajib diisi');
    const u = await this.identity.byPhone(phone);
    if (!u) throw new NotFoundException('User tidak ditemukan');
    const obf = `${String(u.name).slice(0, 2)}***`;
    return { data: { id: u.id, name: obf } };
  }
}

// helper alias supaya statusnya 400
class BadRequestLike extends Error {
  constructor() {
    super('contentBase64 wajib diisi');
  }
}
