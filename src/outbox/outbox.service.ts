import { Inject, Injectable, Logger } from '@nestjs/common';
import { OUTBOX_STORE, OutboxJob, OutboxRecord, OutboxStore } from './outbox.store';

type Handler = (payload: Record<string, unknown>) => Promise<void> | void;

// OutboxService: antrean tahan restart. commit() menulis event DALAM SATU
// unit atomic bersama pledge (lihat OutboxStore.appendAtomicWith), masih
// membiarkan proses async dilakukan terpisah via process() — dengan begini,
// crash di tengah jalan TIDAK membuat dana menggantung: saat restart,
// process() membaca ulang event PENDING dari store dan menyelesaikannya.
// Gagal eksekusi membuat event tetap PENDING (attempts++) → bisa retry.
@Injectable()
export class OutboxService {
  private readonly handlers = new Map<string, Handler>();
  private readonly logger = new Logger('OutboxService');

  constructor(@Inject(OUTBOX_STORE) private readonly store: OutboxStore) {}

  registerHandler(queue: string, handler: Handler): void {
    this.handlers.set(queue, handler);
  }

  // Alias semantik: commit event + pledge dalam satu atomic batch.
  async commit(job: OutboxJob, alongside?: () => Promise<unknown>): Promise<OutboxRecord> {
    return this.store.appendAtomicWith(job, alongside ?? (async () => undefined));
  }

  async pending(queue?: string): Promise<OutboxRecord[]> {
    return this.store.listPending(queue);
  }

  // Drain event PENDING (dipanggil async oleh worker maupun saat restart).
  async process(queue?: string): Promise<{ processed: number; failed: number }> {
    const events = await this.store.listPending(queue);
    let processed = 0;
    let failed = 0;
    for (const ev of events) {
      const handler = this.handlers.get(ev.queue);
      try {
        if (!handler) throw new Error(`BELUM_ADA_WORKER utk queue ${ev.queue}`);
        await handler(ev.payload);
        await this.store.markDone(ev.id);
        processed += 1;
      } catch (e: unknown) {
        failed += 1;
        const msg = (e as Error)?.message ?? String(e);
        try {
          await this.store.markFailed(ev.id, msg);
        } catch (e2: unknown) {
          this.logger.error(`markFailed gagal untuk event ${ev.id}: ${(e2 as Error).message}`);
        }
        this.logger.error(`outbox ${ev.queue}/${ev.id} gagal: ${msg} — tetap PENDING utk retry/restart`);
      }
    }
    return { processed, failed };
  }
}

export type { OutboxJob, OutboxRecord, OutboxStore } from './outbox.store';
