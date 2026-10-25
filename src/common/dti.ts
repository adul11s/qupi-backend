import { DomainError } from './errors';

// Fase-3 #5: DTI (debt-to-income) — cicilan per bulan ≤ 25% penghasilan
// terverifikasi. Dipakai di checkout, QRIS PayLater, dan tagihan PayLater.
export const assertDti = (monthlyIncome: number | null | undefined, installmentPerMonth: number): void => {
  if (monthlyIncome == null) throw new DomainError('NO_INCOME_DATA', 'Penghasilan belum terverifikasi, hubungi admin', 403 as never);
  const max = Math.floor(monthlyIncome * 0.25);
  if (installmentPerMonth > max) {
    throw new DomainError('DTI_EXCEEDED', `Cicilan per bulan Rp${installmentPerMonth.toLocaleString('id-ID')} melebihi 25% penghasilan (maks Rp${max.toLocaleString('id-ID')})`, 400 as never);
  }
};
