import { useState } from 'react'
import { useStore } from '@/lib/data/store'
import { useLang } from '@/lib/lang'
import { rokad, partyName } from '@/lib/select'
import { money } from '@/lib/money'
import { TODAY, addDays, fmtFull } from '@/lib/date'
import { Card, PageHeader, Segmented, SectionTitle } from '@/components/ui'
import { Icon } from '@/components/icons'
import { modeKey } from '@/lib/labels'
import type { PayMode } from '@/lib/types'

export function Rokad() {
  const { state } = useStore()
  const { t } = useLang()
  const [date, setDate] = useState(TODAY)
  const r = rokad(state, date)

  const dayOptions = [addDays(TODAY, -2), addDays(TODAY, -1), TODAY].map((d) => ({ value: d, label: d === TODAY ? t('common.today') : fmtFull(d) }))

  const moves: { label: string; sub: string; amount: number; dir: 'in' | 'out' }[] = []
  for (const s of state.sales.filter((x) => x.date === date && x.paidMode === 'cash' && x.paidNow > 0)) moves.push({ label: partyName(state, s.partyId), sub: t('rokad.cashSale', { no: s.no }), amount: s.paidNow, dir: 'in' })
  for (const p of state.payments.filter((x) => x.date === date && x.mode === 'cash')) moves.push({ label: partyName(state, p.partyId), sub: p.direction === 'in' ? t('led.paymentReceived') : t('led.paymentMade'), amount: p.amount, dir: p.direction })
  for (const e of state.expenses.filter((x) => x.date === date && x.mode === 'cash')) moves.push({ label: e.category, sub: e.note ?? t('rokad.expense'), amount: e.amount, dir: 'out' })

  const modes: PayMode[] = ['cash', 'upi', 'bank', 'cheque', 'other']

  return (
    <div>
      <PageHeader title={t('rokad.title')} sub={t('rokad.sub')} />

      <div className="mb-4 sm:w-96"><Segmented value={date} onChange={setDate} options={dayOptions} /></div>

      <Card className="p-5">
        <SectionTitle>{t('rokad.cashOn', { date: fmtFull(date) })}</SectionTitle>
        <div className="space-y-2.5">
          <Row label={t('rokad.opening')} value={r.openingCash} strong />
          <Row label={t('rokad.cashIn')} value={r.cashIn} tone="in" />
          <Row label={t('rokad.cashOut')} value={-r.cashOut} tone="out" />
          <div className="!mt-3 flex items-center justify-between border-t border-line pt-3">
            <div className="font-bold text-ink-900">{t('rokad.closing')}</div>
            <div className="text-2xl font-bold tabular text-brand-700">{money(r.closingCash)}</div>
          </div>
        </div>
      </Card>

      <Card className="mt-4 p-5">
        <SectionTitle>{t('rokad.byMode')}</SectionTitle>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {modes.map((m) => (
            <div key={m} className="rounded-xl bg-canvas p-3 text-center">
              <div className="text-xs font-semibold uppercase text-ink-400">{t(modeKey[m])}</div>
              <div className="mt-1 font-bold tabular text-ink-900">{money(r.byMode[m] ?? 0)}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="mt-4">
        <div className="border-b border-line px-4 py-3 text-sm font-bold uppercase tracking-wide text-ink-500">{t('rokad.movements')}</div>
        {moves.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-400">{t('rokad.noMovements')}</p>
        ) : (
          <div className="divide-y divide-line">
            {moves.map((m, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <span className={`grid h-9 w-9 place-items-center rounded-lg ${m.dir === 'in' ? 'bg-brand-50 text-brand-600' : 'bg-rose-50 text-rose-600'}`}>
                  {m.dir === 'in' ? <Icon.arrowDown className="h-4 w-4" /> : <Icon.arrowUp className="h-4 w-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-ink-900">{m.label}</div>
                  <div className="text-xs text-ink-400">{m.sub}</div>
                </div>
                <div className={`font-bold tabular ${m.dir === 'in' ? 'text-brand-600' : 'text-rose-600'}`}>{m.dir === 'in' ? '+' : '−'} {money(m.amount)}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

function Row({ label, value, strong, tone }: { label: string; value: number; strong?: boolean; tone?: 'in' | 'out' }) {
  const color = tone === 'in' ? 'text-brand-600' : tone === 'out' ? 'text-rose-600' : 'text-ink-900'
  return (
    <div className="flex items-center justify-between">
      <div className={strong ? 'font-semibold text-ink-900' : 'text-ink-700'}>{label}</div>
      <div className={`tabular font-bold ${color}`}>{money(value)}</div>
    </div>
  )
}
