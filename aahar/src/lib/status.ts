import type { ReceivableStatus, PayMode } from '@/lib/types'
import type { Tone } from '@/components/ui'

export const receivableMeta: Record<ReceivableStatus, { label: string; tone: Tone }> = {
  paid: { label: 'Paid', tone: 'green' },
  partial: { label: 'Partial', tone: 'amber' },
  upcoming: { label: 'Upcoming', tone: 'blue' },
  dueTomorrow: { label: 'Due tomorrow', tone: 'amber' },
  dueToday: { label: 'Due today', tone: 'amber' },
  overdue: { label: 'Overdue', tone: 'red' },
}

export const payModeLabel: Record<PayMode, string> = {
  cash: 'Cash',
  upi: 'UPI',
  bank: 'Bank transfer',
  cheque: 'Cheque',
  other: 'Other',
}

export const payModes: PayMode[] = ['cash', 'upi', 'bank', 'cheque', 'other']
