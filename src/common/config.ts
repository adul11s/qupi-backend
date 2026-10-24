export const opts = () => ({
  pinMaxAttempts: Number(process.env.PIN_MAX_ATTEMPTS ?? 5),
  otpTtlMinutes: Number(process.env.OTP_TTL_MINUTES ?? 5),
  otpMaxPerMinute: Number(process.env.OTP_MAX_PER_MINUTE ?? 3),
  sessionIdleMinutes: Number(process.env.SESSION_IDLE_MINUTES ?? 15),
  providerMode: (process.env.PROVIDER_MODE ?? 'success') as 'success' | 'fail' | 'timeout',
});
