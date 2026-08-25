import type { Product, PayMode, ReceivableStatus, Role, SaleStatus } from '@/lib/types'
import type { Lang } from '@/lib/lang'
import type { TKey } from '@/lib/translations'
import type { Tone } from '@/components/ui'

/** Product name in the active language (falls back to English name). */
export function pname(p: Product | undefined, lang: Lang): string {
  if (!p) return ''
  return lang === 'hi' && p.hindi ? p.hindi : p.name
}

export const modeKey: Record<PayMode, TKey> = {
  cash: 'mode.cash',
  upi: 'mode.upi',
  bank: 'mode.bank',
  cheque: 'mode.cheque',
  other: 'mode.other',
}

export const statusKey: Record<ReceivableStatus, TKey> = {
  paid: 'status.paid',
  partial: 'status.partial',
  upcoming: 'status.upcoming',
  dueTomorrow: 'status.dueTomorrow',
  dueToday: 'status.dueToday',
  overdue: 'status.overdue',
}

export const saleStatusKey: Record<SaleStatus, TKey> = {
  pending: 'status.pending',
  dispatched: 'status.dispatched',
  delivered: 'status.delivered',
}

export const roleKey: Record<Role, TKey> = {
  owner: 'role.owner',
  admin: 'role.admin',
  accountant: 'role.accountant',
  sales: 'role.sales',
  store: 'role.store',
  production: 'role.production',
  dispatch: 'role.dispatch',
  viewer: 'role.viewer',
}

export const receivableTone: Record<ReceivableStatus, Tone> = {
  paid: 'green',
  partial: 'amber',
  upcoming: 'blue',
  dueTomorrow: 'amber',
  dueToday: 'amber',
  overdue: 'red',
}

export const payModes: PayMode[] = ['cash', 'upi', 'bank', 'cheque', 'other']
