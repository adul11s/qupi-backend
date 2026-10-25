export interface AuditEntry {
  actorId: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  detail?: Record<string, unknown> | null;
}

export interface AuditRow extends AuditEntry {
  id: string;
  createdAt: Date;
}

export interface AuditFilter {
  action?: string;
  targetType?: string;
  targetId?: string;
  limit?: number;
}

// Port audit store: prisma (runtime) / in-memory (unit test).
export const AUDIT_STORE = 'AUDIT_STORE';

export interface AuditStore {
  record(entry: AuditEntry): Promise<AuditRow>;
  list(filter: AuditFilter): Promise<AuditRow[]>;
}
