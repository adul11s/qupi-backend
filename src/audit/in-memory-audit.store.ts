import { AuditEntry, AuditFilter, AuditRow, AuditStore } from './audit.store';

// Versi in-memory untuk unit test (tanpa Postgres).
// Append-only: tidak ada update/delete.
export class InMemoryAuditStore implements AuditStore {
  readonly rows: AuditRow[] = [];
  private seq = 0;

  async record(entry: AuditEntry): Promise<AuditRow> {
    this.seq += 1;
    const row: AuditRow = { ...entry, detail: entry.detail ?? null, id: `aud-${this.seq}`, createdAt: new Date() };
    this.rows.push(row);
    return row;
  }

  async list(filter: AuditFilter): Promise<AuditRow[]> {
    const limit = filter.limit ?? 50;
    return this.rows
      .filter(
        (r) =>
          (!filter.action || r.action === filter.action) &&
          (!filter.targetType || r.targetType === filter.targetType) &&
          (!filter.targetId || r.targetId === filter.targetId),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}
