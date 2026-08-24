import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '@/lib/data/store'
import { saleTotal, partyName, dueDate, receivables } from '@/lib/select'
import { money } from '@/lib/money'
import { fmtFull } from '@/lib/date'
import { Card, PageHeader, SearchBox, Button, Badge, Empty } from '@/components/ui'
import { Icon } from '@/components/icons'
import { receivableMeta } from '@/lib/status'

const statusTone = { pending: 'gray', dispatched: 'blue', delivered: 'green' } as const

export function Sales() {
  const { state } = useStore()
  const nav = useNavigate()
  const [q, setQ] = useState('')

  const recIndex = useMemo(() => {
    const m = new Map<string, ReturnType<typeof receivables>[number]>()
    for (const r of receivables(state)) m.set(r.sale.id, r)
    return m
  }, [state])

  const sales = state.sales
    .filter((s) => (s.no + partyName(state, s.partyId)).toLowerCase().includes(q.toLowerCase()))
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  const total = sales.reduce((s, x) => s + saleTotal(x), 0)

  return (
    <div>
      <PageHeader
        title="Sales"
        hindi="बिक्री"
        sub={`${sales.length} invoices · ${money(total)}`}
        action={<Button className="hidden sm:inline-flex" onClick={() => nav('/sales/new')}><Icon.plus className="h-5 w-5" /> New Sale</Button>}
      />

      <div className="mb-4"><SearchBox value={q} onChange={setQ} placeholder="Search invoice no. or customer…" /></div>

      {sales.length === 0 ? (
        <Card><Empty icon="sales" title="No sales yet" sub="Create your first sale to generate a parchi." /></Card>
      ) : (
        <Card className="divide-y divide-line">
          {sales.map((s) => {
            const rec = recIndex.get(s.id)
            const paidChip = rec ? receivableMeta[rec.status] : null
            return (
              <div key={s.id} className="flex items-center gap-3 px-4 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-ink-900">{s.no}</span>
                    <Badge tone={statusTone[s.status]}>{s.status}</Badge>
                  </div>
                  <div className="truncate text-sm text-ink-500">{partyName(state, s.partyId)}</div>
                  <div className="text-xs text-ink-400">{fmtFull(s.date)} · due {fmtFull(dueDate(s))}</div>
                </div>
                <div className="text-right">
                  <div className="font-bold tabular text-ink-900">{money(saleTotal(s))}</div>
                  {paidChip && <Badge tone={paidChip.tone}>{paidChip.label}</Badge>}
                </div>
                <button onClick={() => nav('/parchi/' + s.id)} className="grid h-9 w-9 place-items-center rounded-lg text-ink-400 hover:bg-canvas" aria-label="Parchi">
                  <Icon.print className="h-5 w-5" />
                </button>
              </div>
            )
          })}
        </Card>
      )}
    </div>
  )
}
