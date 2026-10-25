import { Inject, Injectable } from '@nestjs/common';
import { AUDIT_STORE, AuditEntry, AuditFilter, AuditStore } from './audit.store';

// AuditService: satu pintu pencatatan aksi sensitif (approve KYC, ubah
// penghasilan, refund, aksi admin lain). Append-only: tidak ada update/delete.
export const AUDIT_ACTIONS = {
  kycUpdate: 'KYC_UPDATE',
  incomeSet: 'INCOME_SET',
  limitInfoSet: 'LIMIT_INFO_SET',
  refund: 'REFUND',
} as const;

@Injectable()
export class AuditService {
  constructor(@Inject(AUDIT_STORE) private readonly store: AuditStore) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.store.record(entry);
  }

  async list(filter: AuditFilter) {
    return this.store.list(filter);
  }
}
