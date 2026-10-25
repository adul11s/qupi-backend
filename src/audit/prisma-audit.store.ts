import type { PrismaService } from '../common/prisma.service';
import type { AuditEntry, AuditFilter, AuditRow, AuditStore } from './audit.store';
import type Prisma from '@prisma/client';

// Adapter prisma: append-only ke tabel AuditLog.
export class PrismaAuditStore implements AuditStore {
  constructor(private readonly db: PrismaService) {}

  async record(entry: AuditEntry): Promise<AuditRow> {
    const row = await this.db.auditLog.create({
      data: {
        actorId: entry.actorId,
        actorRole: entry.actorRole,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        detail: (entry.detail ?? undefined) as Prisma.Prisma.InputJsonValue | undefined,
      },
    });
    return { ...entry, detail: (row.detail ?? null) as Record<string, unknown> | null, id: row.id, createdAt: row.createdAt };
  }

  async list(filter: AuditFilter): Promise<AuditRow[]> {
    const limit = Math.min(filter.limit ?? 50, 200);
    const rows = await this.db.auditLog.findMany({
      where: {
        ...(filter.action ? { action: filter.action } : {}),
        ...(filter.targetType ? { targetType: filter.targetType } : {}),
        ...(filter.targetId ? { targetId: filter.targetId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      actorId: r.actorId,
      actorRole: r.actorRole,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      detail: (r.detail ?? null) as Record<string, unknown> | null,
      createdAt: r.createdAt,
    }));
  }
}
