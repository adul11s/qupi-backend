export const opts = () => ({
  pinMaxAttempts: Number(process.env.PIN_MAX_ATTEMPTS ?? 5),
  otpTtlMinutes: Number(process.env.OTP_TTL_MINUTES ?? 5),
  otpMaxPerMinute: Number(process.env.OTP_MAX_PER_MINUTE ?? 3),
  sessionIdleMinutes: Number(process.env.SESSION_IDLE_MINUTES ?? 15),
  paylaterLimitMin: Number(process.env.PAYLATER_LIMIT_MIN ?? 500_000),
  paylaterLimitMax: Number(process.env.PAYLATER_LIMIT_MAX ?? 15_000_000),
  paylaterLimitMultiplier: Number(process.env.PAYLATER_LIMIT_MULTIPLIER ?? 2.5),
  penaltyPctPerDay: Number(process.env.PENALTY_PCT_PER_DAY ?? 1),
  qrisTtlSeconds: Number(process.env.QRIS_TTL_SECONDS ?? 30),
  // Fase-2 #7: batas SALDO wallet sesuai tier verifikasi (topup yang membuat
  // saldo melewati batas ≈ 'bounce' / ditolak).
  tierBalanceCap: {
    T1: Number(process.env.TIER1_BALANCE_CAP ?? 10_000_000),
    T2: Number(process.env.TIER2_BALANCE_CAP ?? 20_000_000),
  } as Record<string, number>,
});
export const tierCapFor = (tier: string): number => opts().tierBalanceCap[tier] ?? opts().tierBalanceCap.T1;

export type ProviderMode = 'success' | 'fail' | 'timeout';

// Simulasi provider eksternal: BKI/topup, bank, bill. Mode dari env supaya
// skenario sukses/gagal/timeout bisa dipilih tanpa ubah kode.
export const providerMode = (which: 'BKI' | 'BANK' | 'BILL' | 'PROVIDER'): ProviderMode => {
  const v = (which === 'PROVIDER' ? process.env.PROVIDER_MODE : process.env[`${which}_MODE`]) ?? 'success';
  return (['success', 'fail', 'timeout'].includes(v) ? v : 'success') as ProviderMode;
};
