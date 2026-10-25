import { OutboxService } from '../src/outbox/outbox.service';
import { InMemoryOutboxStore } from '../src/outbox/in-memory-outbox.store';

describe('Outbox: drain dua kali jalan (exactly-once per-payload) & crash-mid-call', () => {
  it('sekali drain: tiap event diproses tepat sekali dan tidak dibaca ulang', async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new OutboxService(store);
    const handled: unknown[] = [];
    outbox.registerHandler('settlement', async (payload) => {
      handled.push(payload);
      await Promise.resolve();
    });
    await outbox.commit({ queue: 'settlement', payload: { transactionId: 'tx-1' } });
    await outbox.commit({ queue: 'settlement', payload: { transactionId: 'tx-2' } });
    await outbox.commit({ queue: 'retry', payload: { note: 'beda queue' } });

    const first = await outbox.process('settlement');
    expect(first).toEqual({ processed: 2, failed: 0 });
    expect(handled.map((h) => (h as { transactionId: string }).transactionId).sort()).toEqual(['tx-1', 'tx-2']);

    // drain kedua: tidak ada PENDING, tidak ada handler terpanggil ulang
    const second = await outbox.process('settlement');
    expect(second.processed).toBe(0);
    expect(handled).toHaveLength(2);

    // drain tanpa filter queue: event 'retry' tetap menunggu handler-nya sendiri
    const failedQueues = await outbox.process();
    expect(failedQueues.failed).toBe(1);
    expect((await outbox.pending('retry'))[0].attempts).toBe(1);
  });

  it('commit + alongside gagal -> tidak ada event tertinggal (atomicity)', async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new OutboxService(store);
    await expect(
      outbox.commit({ queue: 'settlement', payload: {} }, async () => {
        throw new Error('pledge gagal');
      }),
    ).rejects.toThrow('pledge gagal');
    expect((await outbox.pending('settlement'))).toHaveLength(0);
  });

  it('handler gagal -> event tetap PENDING (attempts naik) dan bisa diproses ulang', async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new OutboxService(store);
    let fail = true;
    outbox.registerHandler('settlement', async () => {
      if (fail) throw new Error('PROVIDER_TIMEOUT');
    });
    await outbox.commit({ queue: 'settlement', payload: { transactionId: 'tx-x' } });
    const r1 = await outbox.process('settlement');
    expect(r1).toEqual({ processed: 0, failed: 1 });
    const [rec] = await outbox.pending('settlement');
    expect(rec.attempts).toBe(1);
    expect(rec.lastError).toBe('PROVIDER_TIMEOUT');
    fail = false;
    const r2 = await outbox.process('settlement');
    expect(r2.processed).toBe(1);
  });
});
