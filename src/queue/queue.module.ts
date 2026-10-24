import { Injectable, Module } from '@nestjs/common';

// Stub BullMQ: antrean disimulasikan di memori. Aktivasi Redis sesungguhnya
// tinggal mengganti deliverEnqueue dengan producer BullMQ saat REDIS_URL tersedia.
export interface QueueJob {
  queue: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

@Injectable()
export class QueueStubService {
  readonly jobs: QueueJob[] = [];

  get connected(): boolean {
    return Boolean(process.env.REDIS_URL);
  }

  async enqueue(queue: string, payload: Record<string, unknown>): Promise<QueueJob> {
    const job: QueueJob = { queue, payload, createdAt: new Date().toISOString() };
    this.jobs.push(job);
    if (this.connected) {
      // TODO Task >2.3: ganti dengan bullmq Queue.add() ketika Redis aktif.
      console.log(`[queue:${queue}] (stub -> redis belum aktif)`, JSON.stringify(job));
    }
    return job;
  }
}

@Module({
  providers: [QueueStubService],
  exports: [QueueStubService],
})
export class QueueModule {}
