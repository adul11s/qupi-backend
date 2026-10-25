import { RiskService } from '../src/risk/risk.module';

// Checklist 5: aturan risk selaras keputusan produk.
// - 'dompet tanpa batas transaksi': rule transfer 10jt DIHAPUS — transfer
//   sebesar apa pun (<= cap safety 2.5 miliar) lolos risk engine.
// - QRIS tetap dibatasi 2jt/transaksi + velocity 20/hari.
// - Rule nominal paylater dihapus (digovern limit + DTI).
describe('Risk rules: selaras keputusan produk', () => {
  it('transfer 10jt+ TIDAK ditolak risk engine lagi (dompet tanpa batas)', () => {
    const risk = new RiskService();
    expect(risk.evaluate('TRANSFER', 10_000_000, { userId: 'u1' }).approved).toBe(true);
    expect(risk.evaluate('TRANSFER', 1_500_000_000, { userId: 'u1' }).approved).toBe(true);
  });

  it('cap safety transfer 2.5 miliar tetap REJECT', () => {
    const risk = new RiskService();
    const v = risk.evaluate('TRANSFER', 2_600_000_000, { userId: 'u1' });
    expect(v.approved).toBe(false);
    expect(v.reason).toContain('transfer_safety_cap');
  });

  it('QRIS maksimal 2jt per transaksi', () => {
    const risk = new RiskService();
    expect(risk.evaluate('QRIS', 2_000_000, { userId: 'u1', txCountToday: 0 }).approved).toBe(true);
    expect(risk.evaluate('QRIS', 2_000_001, { userId: 'u1', txCountToday: 0 }).approved).toBe(false);
  });

  it('Rule quantitas QRIS: >20 transaksi/hari → REJECT', () => {
    const risk = new RiskService();
    expect(risk.evaluate('QRIS', 50_000, { userId: 'u1', txCountToday: 20 }).approved).toBe(false);
    expect(risk.evaluate('QRIS', 50_000, { userId: 'u1', txCountToday: 19 }).approved).toBe(true);
  });

  it('rule nominal PAYLATER sudah dihapus — cek limit 20jt lolos', () => {
    const risk = new RiskService();
    expect(risk.evaluate('PAYLATER', 20_000_000, { userId: 'u1' }).approved).toBe(true);
  });

  it('RISK_RULES_JSON tetap bisa menimpa rule (fail-closed ke default bila rusak)', () => {
    const saved = process.env.RISK_RULES_JSON;
    try {
      process.env.RISK_RULES_JSON = JSON.stringify([{ name: 'transfer_1jt', kind: 'TRANSFER', max: 1_000_000, action: 'REJECT' }]);
      expect(new RiskService().evaluate('TRANSFER', 2_000_000, { userId: 'u1' }).approved).toBe(false);
      process.env.RISK_RULES_JSON = '{{rusak}}';
      expect(new RiskService().evaluate('TRANSFER', 2_000_000, { userId: 'u1' }).approved).toBe(true); // default cap
    } finally {
      if (saved === undefined) delete process.env.RISK_RULES_JSON;
      else process.env.RISK_RULES_JSON = saved;
    }
  });
});
