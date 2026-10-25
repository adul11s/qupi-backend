import { OutboxJob, OutboxRecord, OutboxStore } from './outbox.store';

// In-memory untuk unit test. Atomicity disimulasikan: append + alongside
// dijalankan dalam satu blok; worker TIDAK otomatis jalan saat commit
// (proses adalah langkah terpisah), sehingga skenario "crash sebelum process"
// bisa diuji dengan me-restart service pada store yang sama.
export class InMemoryOutboxStore implements OutboxStore {
  readonly records: OutboxRecord[] = [];
  private seq = 0;

  async appendAtomicWith(job: OutboxJob, alongside: () => Promise<unknown>): Promise<OutboxRecord> {
    this.seq += 1;
    const rec: OutboxRecord = {
      id: `out-${this.seq}`,
      queue: job.queue,
      payload: job.payload,
      status: 'PENDING',
      attempts: 0,
      lastError: null,
      createdAt: new Date(),
      processedAt: null,
    };
    // satu blok atomic: sebelum return, pledge dan event keduanya sudah terekam
    // atau keduanya tidak (error di alongside → tidak ada record tertinggal).
    await alongside();
    this.records.push(rec);
    return rec;
  }

  async listPending(queue?: string): Promise<OutboxRecord[]> {
    return this.records.filter((r) => r.status === 'PENDING' && (!queue || r.queue === queue));
  }

  async markDone(id: string): Promise<void> {
    const r = this.records.find((x) => x.id === id);
    if (r) {
      r.status = 'DONE';
      r.processedAt = new Date();
    }
  }

  async markFailed(id: string, error: string): Promise<void> {
    const r = this.records.find((x) => x.id === id);
    if (r) {
      r.attempts += 1;
      r.lastError = error;
    }
  }
}
