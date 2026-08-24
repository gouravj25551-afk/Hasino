import { useMemo, useState } from 'react'
import { useStore } from '@/lib/data/store'
import { ageing, saleTotal, productName, partyName } from '@/lib/select'
import { money, num } from '@/lib/money'
import { TODAY, addDays } from '@/lib/date'
import { Card, PageHeader, Segmented, Button } from '@/components/ui'
import { Icon } from '@/components/icons'

type Report = 'ageing' | 'product' | 'customer' | 'collections' | 'expenses' | 'sales7'

export function Reports() {
  const [report, setReport] = useState<Report>('ageing')

  return (
    <div>
      <PageHeader title="Reports" hindi="रिपोर्ट" sub="The handful an owner actually acts on — the rest are a tap away."
        action={<Button variant="outline" className="hidden sm:inline-flex" onClick={() => window.print()}><Icon.download className="h-5 w-5" /> Export</Button>} />

      <div className="mb-4">
        <Segmented
          value={report}
          onChange={setReport}
          options={[
            { value: 'ageing', label: '⭐ Ageing' },
            { value: 'product', label: '⭐ Sales by product' },
            { value: 'customer', label: 'Sales by customer' },
            { value: 'collections', label: 'Collections' },
            { value: 'sales7', label: 'Daily sales' },
            { value: 'expenses', label: 'Expenses' },
          ]}
        />
      </div>

      {report === 'ageing' && <Ageing />}
      {report === 'product' && <ByProduct />}
      {report === 'customer' && <ByCustomer />}
      {report === 'collections' && <Collections />}
      {report === 'sales7' && <DailySales />}
      {report === 'expenses' && <ByExpense />}

      <Card className="mt-4 p-4 text-sm text-ink-500">
        <span className="font-semibold text-ink-700">⭐ Owner’s daily two:</span> Ageing tells you who to chase; Sales-by-product tells you what to make next. The others matter weekly or at month-end, not every morning.
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
  const rows = ageing(state)
  const t = rows.reduce((a, r) => ({ total: a.total + r.total, current: a.current + r.current, d1: a.d1 + r.d1_30, d2: a.d2 + r.d31_60, d3: a.d3 + r.d60plus }), { total: 0, current: 0, d1: 0, d2: 0, d3: 0 })
  return (
    <Wrap title="Customer outstanding — ageing">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase text-ink-400">
            <th className="px-4 py-2 font-semibold">Customer</th>
            <th className="px-3 py-2 text-right font-semibold">Not due</th>
            <th className="px-3 py-2 text-right font-semibold">1–30d</th>
            <th className="px-3 py-2 text-right font-semibold">31–60d</th>
            <th className="px-3 py-2 text-right font-semibold">60d+</th>
            <th className="px-4 py-2 text-right font-semibold">Total</th>
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
            <td className="px-4 py-2.5 text-ink-900">Total</td>
            <td className="px-3 py-2.5 text-right tabular">{money(t.current)}</td>
            <td className="px-3 py-2.5 text-right tabular text-amber-700">{money(t.d1)}</td>
            <td className="px-3 py-2.5 text-right tabular text-orange-700">{money(t.d2)}</td>
            <td className="px-3 py-2.5 text-right tabular text-rose-700">{money(t.d3)}</td>
            <td className="px-4 py-2.5 text-right tabular text-ink-900">{money(t.total)}</td>
          </tr>
        </tfoot>
      </table>
    </Wrap>
  )
}

function ByProduct() {
  const { state } = useStore()
  const map = useMemo(() => {
    const m = new Map<string, { bags: number; amount: number }>()
    for (const s of state.sales) for (const l of s.lines) {
      const cur = m.get(l.productId) ?? { bags: 0, amount: 0 }
      cur.bags += l.qty; cur.amount += l.qty * l.rate
      m.set(l.productId, cur)
    }
    return [...m.entries()].sort((a, b) => b[1].amount - a[1].amount)
  }, [state])
  const max = Math.max(...map.map(([, v]) => v.amount), 1)
  return (
    <Wrap title="Sales by product">
      <div className="space-y-3 p-4">
        {map.map(([pid, v]) => (
          <div key={pid}>
            <div className="mb-1 flex justify-between text-sm">
              <span className="font-semibold text-ink-900">{productName(state, pid)}</span>
              <span className="tabular text-ink-500">{num(v.bags)} bags · <span className="font-bold text-ink-900">{money(v.amount)}</span></span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-canvas">
              <div className="h-full rounded-full bg-brand-500" style={{ width: `${(v.amount / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </Wrap>
  )
}

function ByCustomer() {
  const { state } = useStore()
  const rows = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of state.sales) m.set(s.partyId, (m.get(s.partyId) ?? 0) + saleTotal(s))
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [state])
  return (
    <Wrap title="Sales by customer">
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
  const modes = ['cash', 'upi', 'bank', 'cheque', 'other'] as const
  const totals = modes.map((m) => ({ m, v: state.payments.filter((p) => p.direction === 'in' && p.mode === m).reduce((s, p) => s + p.amount, 0) }))
  const grand = totals.reduce((s, t) => s + t.v, 0)
  return (
    <Wrap title="Collections by mode">
      <table className="w-full text-sm">
        <tbody className="divide-y divide-line">
          {totals.map((t) => (
            <tr key={t.m}>
              <td className="px-4 py-3 font-semibold capitalize text-ink-900">{t.m}</td>
              <td className="px-4 py-3 text-right tabular text-ink-900">{money(t.v)}</td>
              <td className="w-16 px-4 py-3 text-right text-xs text-ink-400">{grand ? Math.round((t.v / grand) * 100) : 0}%</td>
            </tr>
          ))}
          <tr className="bg-canvas font-bold"><td className="px-4 py-3">Total received</td><td className="px-4 py-3 text-right tabular">{money(grand)}</td><td /></tr>
        </tbody>
      </table>
    </Wrap>
  )
}

function DailySales() {
  const { state } = useStore()
  const days = Array.from({ length: 7 }, (_, i) => addDays(TODAY, -(6 - i)))
  const data = days.map((d) => ({ d, v: state.sales.filter((s) => s.date === d).reduce((s, x) => s + saleTotal(x), 0) }))
  const max = Math.max(...data.map((x) => x.v), 1)
  return (
    <Wrap title="Daily sales — last 7 days">
      <div className="flex items-end gap-2 px-4 pt-6 pb-3" style={{ height: 220 }}>
        {data.map((x) => (
          <div key={x.d} className="flex flex-1 flex-col items-center gap-2">
            <div className="text-[10px] font-semibold tabular text-ink-500">{x.v ? money(x.v).replace('₹', '') : ''}</div>
            <div className="flex w-full flex-1 items-end">
              <div className="w-full rounded-t-lg bg-brand-500" style={{ height: `${(x.v / max) * 100}%`, minHeight: x.v ? 4 : 0 }} />
            </div>
            <div className="text-[10px] text-ink-400">{x.d.slice(8)}/{x.d.slice(5, 7)}</div>
          </div>
        ))}
      </div>
    </Wrap>
  )
}

function ByExpense() {
  const { state } = useStore()
  const rows = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of state.expenses) m.set(e.category, (m.get(e.category) ?? 0) + e.amount)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [state])
  const total = rows.reduce((s, [, v]) => s + v, 0)
  return (
    <Wrap title="Expenses by category">
      <table className="w-full text-sm">
        <tbody className="divide-y divide-line">
          {rows.map(([c, v]) => (
            <tr key={c}><td className="px-4 py-3 font-semibold text-ink-900">{c}</td><td className="px-4 py-3 text-right tabular text-rose-600">{money(v)}</td></tr>
          ))}
          <tr className="bg-canvas font-bold"><td className="px-4 py-3">Total</td><td className="px-4 py-3 text-right tabular">{money(total)}</td></tr>
        </tbody>
      </table>
    </Wrap>
  )
}
