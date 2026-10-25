import { AuditService, AUDIT_ACTIONS } from '../src/audit/audit.service';
import { InMemoryAuditStore } from '../src/audit/in-memory-audit.store';
import { AdminController } from '../src/admin/admin.controller';

// stub: test audit memakai AdminController langsung dgn db fake + audit in-memory.
describe('Audit: aksi admin terekam & terbaca via GET /admin/audit (service layer yang di-delegasikan controller)', () => {
  it('approve KYC terekam sebagai KYC_UPDATE', async () => {
    const store = new InMemoryAuditStore();
    const audit = new AuditService(store);
    const db = {
      kycDocument: {
        findUnique: async () => ({ id: 'doc-1', status: 'PENDING' }),
        update: async ({ data }: { data: { status: string } }) => ({ id: 'doc-1', status: data.status }),
      },
      user: { update: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'u-1', ...data }) },
    } as never;
    const controller = new AdminController(db, audit, {} as never);
    const res = await controller.updateDocument({ user: { id: 'admin-1' } }, 'doc-1', { action: 'APPROVE' });
    expect(res.message).toContain('APPROVED');
    const rows = store.rows.filter((r) => r.action === AUDIT_ACTIONS.kycUpdate);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe('admin-1');
    expect(rows[0].targetId).toBe('doc-1');
    expect(rows[0].detail).toMatchObject({ result: 'APPROVED' });
  });

  it('set verified income terekam sebagai INCOME_SET', async () => {
    const store = new InMemoryAuditStore();
    const audit = new AuditService(store);
    const controller = new AdminController(
      { user: { update: async ({ data }: { data: { monthlyIncome: number } }) => ({ id: 'u-2', monthlyIncome: data.monthlyIncome }) } } as never,
      audit,
      {} as never,
    );
    await controller.setVerifiedIncome({ user: { id: 'admin-1' } }, 'u-2', { verifiedIncome: 8_000_000 });
    const rows = store.rows.filter((r) => r.action === AUDIT_ACTIONS.incomeSet);
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toMatchObject({ verifiedIncome: 8_000_000 });
  });

  it('refund terekam sebagai REFUND dengan detail hasil', async () => {
    const store = new InMemoryAuditStore();
    const audit = new AuditService(store);
    const walletStub = { refundTopup: async () => ({ message: 'Refund berhasil', data: ['e-1'] }) } as never;
    const controller = new AdminController({} as never, audit, walletStub);
    await controller.refundTopup({ user: { id: 'admin-1' } }, 'tx-9');
    const rows = store.rows.filter((r) => r.action === AUDIT_ACTIONS.refund);
    expect(rows).toHaveLength(1);
    expect(rows[0].targetType).toBe('TRANSACTION');
    expect(rows[0].targetId).toBe('tx-9');
  });

  it('list (jalur GET /admin/audit) mendukung filter action + target dan urut terbaru', async () => {
    const store = new InMemoryAuditStore();
    const audit = new AuditService(store);
    await audit.record({ actorId: 'a', actorRole: 'ADMIN', action: 'KYC_UPDATE', targetType: 'KYC_DOCUMENT', targetId: 'd1' });
    await audit.record({ actorId: 'a', actorRole: 'ADMIN', action: 'REFUND', targetType: 'TRANSACTION', targetId: 't1', detail: null });
    const all = await audit.list({ limit: 50 }); // tanpa filter
    expect(all).toHaveLength(2);
    const refunds = await audit.list({ action: 'REFUND' });
    expect(refunds).toHaveLength(1);
    expect(refunds[0].action).toBe('REFUND');
    const byTarget = await audit.list({ targetType: 'KYC_DOCUMENT', targetId: 'd1' });
    expect(byTarget).toHaveLength(1);
    expect(all[0].createdAt.getTime()).toBeGreaterThanOrEqual(all[1].createdAt.getTime());
  });
});
