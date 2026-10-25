import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { SessionGuard } from '../common/session.guard';
import { DomainError } from '../common/errors';
import { KycStatus } from '@prisma/client';

// Admin: daftar dokumen KYC + approve/reject/upload_again dengan alasan.
// (Simulasi header X-Admin-Key sederhana.)
@UseGuards(SessionGuard)
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
}
