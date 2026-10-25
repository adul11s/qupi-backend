export const OUTBOX_STORE = 'OUTBOX_STORE';

// Outbox store: event settlement dicatat (idealnya dalam transaction yang
// sama dengan pledge) dan diproses async. Restart proses tidak menghilangkan
// job: event PENDING tetap dibaca ulang dan diproses.
export interface OutboxJob {
  queue: string;
  payload: Record<string, unknown>;
}

export interface OutboxRecord {
  id: string;
  queue: string;
  payload: Record<string, unknown>;
  status: 'PENDING' | 'DONE';
  attempts: number;
  lastError?: string | null;
  createdAt: Date;
  processedAt?: Date | null;
}

export interface OutboxStore {
  // appendAtomicWith: tulis event outbox DALAM SATU unit atomic dengan
  // pledge/side-effect sampingan yang menyertainya (prisma: $transaction
  // interaktif; in-memory: dalam satu blok sinkron sebelum proses naik).
  appendAtomicWith(job: OutboxJob, alongside: () => Promise<unknown>): Promise<OutboxRecord>;
  listPending(queue?: string): Promise<OutboxRecord[]>;
  markDone(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
}
