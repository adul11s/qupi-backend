import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

// Stub modul admin: listing dokumen KYC untuk review. Aksi approve/reject dibuat
// di task >2.3.
@Injectable()
export class AdminService {
  constructor(private readonly db: PrismaService) {}
  async listKyc(): Promise<unknown[]> {
    return this.db.kycDocument.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  }
}

@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly db: PrismaService,
  ) {}

  @Get('kyc')
  async kyc() {
    return { message: 'Daftar dokumen KYC', data: await this.admin.listKyc() };
  }

  @Get('users')
  async users() {
    return { data: await this.db.user.findMany({ select: { id: true, phone: true, name: true, status: true } }) };
  }
}

@Module({
  controllers: [AdminController],
  providers: [AdminService, PrismaService],
})
export class AdminModule {}
