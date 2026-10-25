import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { SessionGuard } from '../common/session.guard';
import { AdminRoleGuard } from '../common/admin-role.guard';
import { DomainError } from '../common/errors';
import { KycStatus } from '@prisma/client';

// Admin: daftar dokumen KYC + approve/reject/upload_again dengan alasan.
// Fase kritis #2: wajib role admin (isAdmin=true), bukan cukup sesi biasa.
@UseGuards(SessionGuard, AdminRoleGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly db: PrismaService) {}

  @Get('kyc/documents')
  async listDocuments(@Query('status') status?: string, @Query('userId') userId?: string) {
    const docs = await this.db.kycDocument.findMany({
      where: {
        ...(status ? { status: status as KycStatus } : {}),
        ...(userId ? { userId } : {}),
      },
      include: { user: { select: { phone: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return { data: docs };
  }

  @Patch('kyc/documents/:id')
  async updateDocument(
    @Param('id') id: string,
    @Body() body: { action: 'APPROVE' | 'REJECT' | 'UPLOAD_AGAIN'; rejectionReason?: string },
  ) {
    const doc = await this.db.kycDocument.findUnique({ where: { id } });
    if (!doc) throw new DomainError('DOC_NOT_FOUND', 'Dokumen tidak ditemukan');
    if (body.action === 'REJECT' && !body.rejectionReason) {
      throw new DomainError('REJECTION_REASON_REQUIRED', 'Alasan penolakan wajib diisi');
    }
    const map = {
      APPROVE: KycStatus.APPROVED,
      REJECT: KycStatus.REJECTED,
      UPLOAD_AGAIN: KycStatus.UPLOAD_AGAIN,
    } as const;
    const updated = await this.db.kycDocument.update({
      where: { id },
      data: { status: map[body.action], rejectionReason: body.rejectionReason ?? null },
    });
    return { message: `Dokumen diperbarui ke status ${updated.status}`, data: updated };
  }

  // Fase-2 #7: admin set data produk — penghasilan bulanan (limit = x2.5) dan
  // tier verifikasi (T2 = NPWP/penghasilan/tempat kerja terverifikasi).
  @Patch('users/:id/limit-info')
  async setUserLimitInfo(
    @Param('id') id: string,
    @Body() body: { monthlyIncome?: number; kycTier?: 'T1' | 'T2' },
  ) {
    const patch: { monthlyIncome?: number; kycTier?: string } = {};
    if (body.monthlyIncome !== undefined) {
      if (!Number.isInteger(body.monthlyIncome) || body.monthlyIncome <= 0) {
        throw new DomainError('INCOME_INVALID', 'monthlyIncome harus integer rupiah > 0', 400 as never);
      }
      patch.monthlyIncome = body.monthlyIncome;
    }
    if (body.kycTier !== undefined) {
      if (!['T1', 'T2'].includes(body.kycTier)) throw new DomainError('TIER_INVALID', 'kycTier harus T1 atau T2', 400 as never);
      patch.kycTier = body.kycTier;
    }
    if (Object.keys(patch).length === 0) throw new DomainError('NOTHING_TO_UPDATE', 'Tidak ada perubahan', 400 as never);
    const user = await this.db.user.update({ where: { id }, data: patch });
    return { message: 'Data limit user diperbarui', data: { id: user.id, monthlyIncome: user.monthlyIncome, kycTier: user.kycTier } };
  }
}
