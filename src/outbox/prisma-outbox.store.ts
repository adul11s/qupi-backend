import type { PrismaService } from '../common/prisma.service';
import type { OutboxJob, OutboxRecord, OutboxStore } from './outbox.store';

// Adapter prisma. Contract: event outbox ditulis DALAM $transaction interaktif
// yang sama dengan side-effect yang menyertai (pledge) — bila alongside batal,
// event juga batal; event PENDING tanpa transaksi terkait tidak pernah
// dieksekusi (worker memverifikasi transaksi PENDING sebelum naruh saldo).
// Hydrate ulang record dari store setelah commit supaya id asli DB yang balik.
export class PrismaOutboxStore implements OutboxStore {
  constructor(private readonly db: PrismaService) {}

  async appendAtomicWith(job: OutboxJob, alongside: () => Promise<unknown>): Promise<OutboxRecord> {
    const created = await this.db.$transaction(async (tx) => {
      const rec = await tx.outboxEvent.create({
        data: { queue: job.queue, payload: job.payload as unknown as { [key: string]: never } },
      });
      await alongside();
      return rec;
    });
    return {
      id: created.id,
      queue: created.queue,
      payload: created.payload as unknown as Record<string, unknown>,
      status: 'PENDING',
      attempts: created.attempts,
      lastError: created.lastError,
      createdAt: created.createdAt,
      processedAt: created.processedAt,
    };
  }

  async listPending(queue?: string): Promise<OutboxRecord[]> {
    const rows = await this.db.outboxEvent.findMany({
      where: { status: 'PENDING', ...(queue ? { queue } : {}) },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return rows.map((r) => this.toRecord(r));
  }

  async markDone(id: string): Promise<void> {
    await this.db.outboxEvent.update({
      where: { id },
      data: { status: 'DONE', processedAt: new Date() },
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db.outboxEvent.update({
      where: { id },
      data: { attempts: { increment: 1 }, lastError: error },
    });
  }

  private toRecord(r: {
    id: string;
    queue: string;
    payload: unknown;
    attempts: number;
    lastError: string | null;
    createdAt: Date;
    processedAt: Date | null;
  }): OutboxRecord {
    return {
      id: r.id,
      queue: r.queue,
      payload: r.payload as unknown as Record<string, unknown>,
      status: 'PENDING',
      attempts: r.attempts,
      lastError: r.lastError,
      createdAt: r.createdAt,
      processedAt: r.processedAt,
    };
  }
}
