// Rupee formatting with the Indian digit grouping (lakh / crore).

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})

const inrPaise = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** ₹1,20,000 — whole rupees, Indian grouping. */
export function money(n: number): string {
  return inr.format(Math.round(n))
}

/** ₹1,20,000.00 — for statements where paise matter. */
export function moneyExact(n: number): string {
  return inrPaise.format(n)
}

/** ₹1.2L / ₹3.4Cr — compact, for tiles. */
export function moneyShort(n: number): string {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(abs >= 1e8 ? 0 : 1)}Cr`
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(abs >= 1e6 ? 0 : 1)}L`
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`
  return `${sign}₹${Math.round(abs)}`
}

export function num(n: number): string {
  return new Intl.NumberFormat('en-IN').format(n)
}
