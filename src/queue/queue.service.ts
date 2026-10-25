import { Injectable, Module } from '@nestjs/common';

// Queue stub ala BullMQ: antrean in-process dengan interval worker.
// Kesediaan Redis/BULLMQ asli menyusul saat REDIS_QUEUE=1.
export interface QueueJob {
  queue: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

type Handler = (payload: Record<string, unknown>) => Promise<void> | void;

@Injectable()
export class QueueService {
  readonly jobs: QueueJob[] = [];
  private handlers = new Map<string, Handler>();

  registerWorker(queue: string, handler: Handler): void {
    this.handlers.set(queue, handler);
  }

  async enqueue(queue: string, payload: Record<string, unknown>): Promise<QueueJob> {
    const job: QueueJob = { queue, payload, createdAt: new Date().toISOString() };
    this.jobs.push(job);
    const h = this.handlers.get(queue);
    if (h) {
      setImmediate(() => {
        void Promise.resolve(h(payload)).catch((e: unknown) =>
          console.error(`[worker:${queue}] gagal:`, (e as Error).message),
        );
      });
    } else {
      console.log(`[queue:${queue}] job masuk (belum ada worker)`);
    }
    return job;
  }
}

export const QUEUES = {
  settlement: 'settlement',
  penalty: 'penalty',
} as const;
