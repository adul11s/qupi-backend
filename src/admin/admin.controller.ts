import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { SessionGuard } from '../common/session.guard';
import { AdminRoleGuard } from '../common/admin-role.guard';
import { DomainError } from '../common/errors';
import { KycStatus } from '@prisma/client';
import { reqUser } from '../common/req-user';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { WalletService } from '../wallet/wallet.service';

// Admin: daftar dokumen KYC + approve/reject/upload_again dengan alasan.
// Fase kritis #2: wajib role admin (isAdmin=true), bukan cukup sesi biasa.
// Fase-6: setiap aksi admin sensitif HARUS tercatat di AuditLog (append-only)
// dan bisa dibaca ulang via GET /admin/audit.
@UseGuards(SessionGuard, AdminRoleGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly db: PrismaService,
    private readonly audit: AuditService,
    private readonly wallet: WalletService,
  ) {}

  private actor(req: unknown): { actorId: string; actorRole: string } {
    const user = reqUser(req);
    return { actorId: user?.id ?? 'unknown', actorRole: 'ADMIN' };
  }

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
    @Req() req: unknown,
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
    const actor = this.actor(req);
    await this.audit.record({
      ...actor,
      action: AUDIT_ACTIONS.kycUpdate,
      targetType: 'KYC_DOCUMENT',
      targetId: id,
      detail: { result: updated.status, rejectionReason: body.rejectionReason ?? null },
    });
    return { message: `Dokumen diperbarui ke status ${updated.status}`, data: updated };
  }

  // Fase-2 #7: admin set data produk — penghasilan bulanan (limit = x2.5) dan
  // tier verifikasi (T2 = NPWP/penghasilan/tempat kerja terverifikasi).
  @Patch('users/:id/limit-info')
  async setUserLimitInfo(
    @Req() req: unknown,
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
    await this.audit.record({
      ...this.actor(req),
      action: AUDIT_ACTIONS.limitInfoSet,
      targetType: 'USER',
      targetId: id,
      detail: patch,
    });
    return { message: 'Data limit user diperbarui', data: { id: user.id, monthlyIncome: user.monthlyIncome, kycTier: user.kycTier } };
  }

  // Fase-3 #5: endpoint khusus set penghasilan TERVERIFIKASI admin.
  // monthlyIncome tidak lagi punya default — limit PayLater hanya terbit
  // setelah admin menset verifiedIncome lewat endpoint ini.
  @Post('users/:id/income')
  async setVerifiedIncome(
    @Req() req: unknown,
    @Param('id') id: string,
    @Body() body: { verifiedIncome: number },
  ) {
    if (body.verifiedIncome === undefined || !Number.isInteger(body.verifiedIncome) || body.verifiedIncome <= 0) {
      throw new DomainError('INCOME_INVALID', 'verifiedIncome harus integer rupiah > 0', 400 as never);
    }
    const user = await this.db.user.update({ where: { id }, data: { monthlyIncome: body.verifiedIncome } });
    await this.audit.record({
      ...this.actor(req),
      action: AUDIT_ACTIONS.incomeSet,
      targetType: 'USER',
      targetId: id,
      detail: { verifiedIncome: body.verifiedIncome, previousIncome: user.monthlyIncome },
    });
    return { message: 'Penghasilan terverifikasi tersimpan', data: { id: user.id, monthlyIncome: user.monthlyIncome } };
  }

  // Fase-6: refund topup dari jalur admin — uang keluar sebagai transaksi
  // ledger REFUND (idempotent) dan aksinya diaudit.
  @Post('transactions/:tid/refund')
  async refundTopup(@Req() req: unknown, @Param('tid') tid: string) {
    const actor = this.actor(req);
    const res = await this.wallet.refundTopup(tid, actor.actorId);
    await this.audit.record({
      ...actor,
      action: AUDIT_ACTIONS.refund,
      targetType: 'TRANSACTION',
      targetId: tid,
      detail: { result: (res as { message: string }).message, entries: (res as { data?: unknown }).data ?? null },
    });
    return res;
  }

  // Fase-6: admin membaca audit log (filter action/target, batas 200).
  @Get('audit')
  async listAudit(
    @Query('action') action?: string,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
    @Query('limit') limit?: string,
  ) {
    const data = await this.audit.list({
      action,
      targetType,
      targetId,
      limit: limit ? Math.max(1, Number(limit)) : 50,
    });
    return { data };
  }
}
