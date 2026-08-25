import { useMemo, useState } from 'react'
import { useStore } from '@/lib/data/store'
import { useLang } from '@/lib/lang'
import { ageing, saleTotal, partyName } from '@/lib/select'
import { money, num } from '@/lib/money'
import { TODAY, addDays } from '@/lib/date'
import { Card, PageHeader, Segmented, Button } from '@/components/ui'
import { Icon } from '@/components/icons'
import { pname, modeKey } from '@/lib/labels'
import type { PayMode } from '@/lib/types'

type Report = 'ageing' | 'product' | 'customer' | 'collections' | 'expenses' | 'sales7'

export function Reports() {
  const { t } = useLang()
  const [report, setReport] = useState<Report>('ageing')

  return (
    <div>
      <PageHeader title={t('rep.title')} sub={t('rep.sub')}
        action={<Button variant="outline" className="hidden sm:inline-flex" onClick={() => window.print()}><Icon.download className="h-5 w-5" /> {t('common.export')}</Button>} />

      <div className="mb-4">
        <Segmented value={report} onChange={setReport} options={[
          { value: 'ageing', label: '⭐ ' + t('rep.ageing') },
          { value: 'product', label: '⭐ ' + t('rep.byProduct') },
          { value: 'customer', label: t('rep.byCustomer') },
          { value: 'collections', label: t('rep.collections') },
          { value: 'sales7', label: t('rep.dailySales') },
          { value: 'expenses', label: t('rep.expenses') },
        ]} />
      </div>

      {report === 'ageing' && <Ageing />}
      {report === 'product' && <ByProduct />}
      {report === 'customer' && <ByCustomer />}
      {report === 'collections' && <Collections />}
      {report === 'sales7' && <DailySales />}
      {report === 'expenses' && <ByExpense />}

      <Card className="mt-4 p-4 text-sm text-ink-500">
        <span className="font-semibold text-ink-700">⭐ {t('rep.ownerTwo')}</span> {t('rep.ownerTwoBody')}
      </Card>
    </div>
  )
}

function Wrap({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line px-4 py-3 font-bold text-ink-900">{title}</div>
      <div className="overflow-x-auto">{children}</div>
    </Card>
  )
}

function Ageing() {
  const { state } = useStore()
  const { t } = useLang()
  const rows = ageing(state)
  const tot = rows.reduce((a, r) => ({ total: a.total + r.total, current: a.current + r.current, d1: a.d1 + r.d1_30, d2: a.d2 + r.d31_60, d3: a.d3 + r.d60plus }), { total: 0, current: 0, d1: 0, d2: 0, d3: 0 })
  return (
    <Wrap title={t('rep.ageingTitle')}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase text-ink-400">
            <th className="px-4 py-2 font-semibold">{t('cust.customers')}</th>
            <th className="px-3 py-2 text-right font-semibold">{t('rep.notDue')}</th>
            <th className="px-3 py-2 text-right font-semibold">1–30d</th>
            <th className="px-3 py-2 text-right font-semibold">31–60d</th>
            <th className="px-3 py-2 text-right font-semibold">60d+</th>
            <th className="px-4 py-2 text-right font-semibold">{t('common.total')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.party.id}>
              <td className="px-4 py-2.5 font-semibold text-ink-900">{r.party.name}</td>
              <td className="px-3 py-2.5 text-right tabular text-ink-500">{r.current ? money(r.current) : '—'}</td>
              <td className="px-3 py-2.5 text-right tabular text-amber-700">{r.d1_30 ? money(r.d1_30) : '—'}</td>
              <td className="px-3 py-2.5 text-right tabular text-orange-700">{r.d31_60 ? money(r.d31_60) : '—'}</td>
              <td className="px-3 py-2.5 text-right tabular text-rose-700">{r.d60plus ? money(r.d60plus) : '—'}</td>
              <td className="px-4 py-2.5 text-right tabular font-bold text-ink-900">{money(r.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-line bg-canvas font-bold">
            <td className="px-4 py-2.5 text-ink-900">{t('common.total')}</td>
            <td className="px-3 py-2.5 text-right tabular">{money(tot.current)}</td>
            <td className="px-3 py-2.5 text-right tabular text-amber-700">{money(tot.d1)}</td>
            <td className="px-3 py-2.5 text-right tabular text-orange-700">{money(tot.d2)}</td>
            <td className="px-3 py-2.5 text-right tabular text-rose-700">{money(tot.d3)}</td>
            <td className="px-4 py-2.5 text-right tabular text-ink-900">{money(tot.total)}</td>
          </tr>
        </tfoot>
      </table>
    </Wrap>
  )
}

function ByProduct() {
  const { state } = useStore()
  const { t, lang } = useLang()
  const map = useMemo(() => {
    const m = new Map<string, { bags: number; amount: number }>()
    for (const s of state.sales) for (const l of s.lines) { const cur = m.get(l.productId) ?? { bags: 0, amount: 0 }; cur.bags += l.qty; cur.amount += l.qty * l.rate; m.set(l.productId, cur) }
    return [...m.entries()].sort((a, b) => b[1].amount - a[1].amount)
  }, [state])
  const max = Math.max(...map.map(([, v]) => v.amount), 1)
  return (
    <Wrap title={t('rep.byProductTitle')}>
      <div className="space-y-3 p-4">
        {map.map(([pid, v]) => (
          <div key={pid}>
            <div className="mb-1 flex justify-between text-sm">
              <span className="font-semibold text-ink-900">{pname(state.products.find((p) => p.id === pid), lang)}</span>
              <span className="tabular text-ink-500">{num(v.bags)} {t('common.bags')} · <span className="font-bold text-ink-900">{money(v.amount)}</span></span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-canvas"><div className="h-full rounded-full bg-brand-500" style={{ width: `${(v.amount / max) * 100}%` }} /></div>
          </div>
        ))}
      </div>
    </Wrap>
  )
}

function ByCustomer() {
  const { state } = useStore()
  const { t } = useLang()
  const rows = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of state.sales) m.set(s.partyId, (m.get(s.partyId) ?? 0) + saleTotal(s))
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [state])
  return (
    <Wrap title={t('rep.byCustomerTitle')}>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-line">
          {rows.map(([pid, amt], i) => (
            <tr key={pid}>
              <td className="px-4 py-3 text-ink-400">{i + 1}</td>
              <td className="px-2 py-3 font-semibold text-ink-900">{partyName(state, pid)}</td>
              <td className="px-4 py-3 text-right tabular font-bold text-ink-900">{money(amt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Wrap>
  )
}

function Collections() {
  const { state } = useStore()
  const { t } = useLang()
  const modes: PayMode[] = ['cash', 'upi', 'bank', 'cheque', 'other']
  const totals = modes.map((m) => ({ m, v: state.payments.filter((p) => p.direction === 'in' && p.mode === m).reduce((s, p) => s + p.amount, 0) }))
  const grand = totals.reduce((s, x) => s + x.v, 0)
  return (
    <Wrap title={t('rep.collectionsTitle')}>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-line">
          {totals.map((x) => (
            <tr key={x.m}>
              <td className="px-4 py-3 font-semibold text-ink-900">{t(modeKey[x.m])}</td>
              <td className="px-4 py-3 text-right tabular text-ink-900">{money(x.v)}</td>
              <td className="w-16 px-4 py-3 text-right text-xs text-ink-400">{grand ? Math.round((x.v / grand) * 100) : 0}%</td>
            </tr>
          ))}
          <tr className="bg-canvas font-bold"><td className="px-4 py-3">{t('rep.totalReceived')}</td><td className="px-4 py-3 text-right tabular">{money(grand)}</td><td /></tr>
        </tbody>
      </table>
    </Wrap>
  )
}

function DailySales() {
  const { state } = useStore()
  const { t } = useLang()
  const days = Array.from({ length: 7 }, (_, i) => addDays(TODAY, -(6 - i)))
  const data = days.map((d) => ({ d, v: state.sales.filter((s) => s.date === d).reduce((s, x) => s + saleTotal(x), 0) }))
  const max = Math.max(...data.map((x) => x.v), 1)
  return (
    <Wrap title={t('rep.dailyTitle')}>
      <div className="flex items-end gap-2 px-4 pt-6 pb-3" style={{ height: 220 }}>
        {data.map((x) => (
          <div key={x.d} className="flex flex-1 flex-col items-center gap-2">
            <div className="text-[10px] font-semibold tabular text-ink-500">{x.v ? money(x.v).replace('₹', '') : ''}</div>
            <div className="flex w-full flex-1 items-end"><div className="w-full rounded-t-lg bg-brand-500" style={{ height: `${(x.v / max) * 100}%`, minHeight: x.v ? 4 : 0 }} /></div>
            <div className="text-[10px] text-ink-400">{x.d.slice(8)}/{x.d.slice(5, 7)}</div>
          </div>
        ))}
      </div>
    </Wrap>
  )
}

function ByExpense() {
  const { state } = useStore()
  const { t } = useLang()
  const rows = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of state.expenses) m.set(e.category, (m.get(e.category) ?? 0) + e.amount)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [state])
  const total = rows.reduce((s, [, v]) => s + v, 0)
  return (
    <Wrap title={t('rep.expensesTitle')}>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-line">
          {rows.map(([c, v]) => (<tr key={c}><td className="px-4 py-3 font-semibold text-ink-900">{c}</td><td className="px-4 py-3 text-right tabular text-rose-600">{money(v)}</td></tr>))}
          <tr className="bg-canvas font-bold"><td className="px-4 py-3">{t('common.total')}</td><td className="px-4 py-3 text-right tabular">{money(total)}</td></tr>
        </tbody>
      </table>
    </Wrap>
  )
}
