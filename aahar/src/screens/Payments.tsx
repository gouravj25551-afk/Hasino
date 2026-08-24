import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '@/lib/data/store'
import { receivables } from '@/lib/select'
import type { Receivable } from '@/lib/types'
import { money } from '@/lib/money'
import { fmtDay, fmtFull, relDue } from '@/lib/date'
import { Card, PageHeader, Button, Badge, Segmented, Empty, Stat } from '@/components/ui'
import { Icon } from '@/components/icons'
import { PaymentSheet } from '@/components/PaymentSheet'
import { receivableMeta, payModeLabel } from '@/lib/status'

type Filter = 'attention' | 'overdue' | 'today' | 'upcoming' | 'history'

export function Payments() {
  const { state } = useStore()
  const nav = useNavigate()
  const [filter, setFilter] = useState<Filter>('attention')
  const [payOpen, setPayOpen] = useState(false)

  const recs = useMemo(() => receivables(state).filter((r) => r.outstanding > 0.5), [state])
  const sum = (rs: Receivable[]) => rs.reduce((s, r) => s + r.outstanding, 0)
  const overdue = recs.filter((r) => r.status === 'overdue')
  const today = recs.filter((r) => r.status === 'dueToday')
  const tomorrow = recs.filter((r) => r.status === 'dueTomorrow')
  const upcoming = recs.filter((r) => r.status === 'upcoming' || r.status === 'partial' || r.status === 'dueTomorrow')

  const shown: Receivable[] =
    filter === 'overdue' ? overdue
    : filter === 'today' ? [...today, ...tomorrow]
    : filter === 'upcoming' ? upcoming
    : filter === 'attention' ? [...overdue, ...today].sort((a, b) => a.daysToDue - b.daysToDue)
    : []

  return (
    <div>
      <PageHeader
        title="Payments"
        hindi="भुगतान"
        sub="Track dues, collect, and stop the reminders automatically."
        action={<Button className="hidden sm:inline-flex" onClick={() => setPayOpen(true)}><Icon.plus className="h-5 w-5" /> Record</Button>}
      />

      <div className="mb-4 grid grid-cols-3 gap-3">
        <Stat label="Overdue" value={money(sum(overdue))} sub={`${overdue.length} invoices`} tone="red" icon="warn" />
        <Stat label="Due today" value={money(sum(today))} sub={`${today.length} invoices`} tone="amber" icon="clock" />
        <Stat label="Upcoming" value={money(sum(upcoming))} sub={`${upcoming.length} invoices`} tone="blue" icon="rupee" />
      </div>

      <div className="mb-4">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'attention', label: 'Needs attention' },
            { value: 'overdue', label: `Overdue (${overdue.length})` },
            { value: 'today', label: `Due soon (${today.length + tomorrow.length})` },
            { value: 'upcoming', label: 'Upcoming' },
            { value: 'history', label: 'History' },
          ]}
        />
      </div>

      {filter === 'history' ? (
        <PaymentHistory />
      ) : shown.length === 0 ? (
        <Card><Empty icon="check" title="All clear" sub="No payments in this bucket right now." /></Card>
      ) : (
        <Card className="divide-y divide-line">
          {shown.map((r) => {
            const m = receivableMeta[r.status]
            return (
              <div key={r.sale.id} className="flex items-center gap-3 px-4 py-3.5">
                <button onClick={() => nav('/customers/' + r.party.id)} className="min-w-0 flex-1 text-left">
                  <div className="truncate font-semibold text-ink-900">{r.party.name}</div>
                  <div className="text-xs text-ink-400">{r.sale.no} · due {fmtFull(r.dueDate)} · {relDue(r.dueDate)}</div>
                </button>
                <div className="text-right">
                  <div className="font-bold tabular text-ink-900">{money(r.outstanding)}</div>
                  <Badge tone={m.tone}>{m.label}</Badge>
                </div>
                <button onClick={() => nav('/customers/' + r.party.id)} className="grid h-9 w-9 place-items-center rounded-lg text-brand-600 hover:bg-brand-50" aria-label="Collect">
                  <Icon.rupee className="h-5 w-5" />
                </button>
              </div>
            )
          })}
        </Card>
      )}

      {/* Mobile record button */}
      <div className="no-print fixed bottom-24 right-4 z-30 sm:hidden">
        <button onClick={() => setPayOpen(true)} className="grid h-14 w-14 place-items-center rounded-full bg-brand-600 text-white shadow-lg">
          <Icon.rupee className="h-6 w-6" />
        </button>
      </div>

      <PaymentSheet open={payOpen} onClose={() => setPayOpen(false)} />
    </div>
  )
}

function PaymentHistory() {
  const { state } = useStore()
  const nav = useNavigate()
  const pays = state.payments.slice().sort((a, b) => (a.date < b.date ? 1 : -1))
  return (
    <Card className="divide-y divide-line">
      {pays.map((p) => {
        const party = state.parties.find((x) => x.id === p.partyId)
        const isIn = p.direction === 'in'
        return (
          <button key={p.id} onClick={() => nav('/customers/' + p.partyId)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-canvas">
            <span className={`grid h-9 w-9 place-items-center rounded-lg ${isIn ? 'bg-brand-50 text-brand-600' : 'bg-rose-50 text-rose-600'}`}>
              {isIn ? <Icon.arrowDown className="h-4 w-4" /> : <Icon.arrowUp className="h-4 w-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold text-ink-900">{party?.name}</div>
              <div className="text-xs text-ink-400">{fmtDay(p.date)} · {payModeLabel[p.mode]} {p.ref ? `· ${p.ref}` : ''}</div>
            </div>
            <div className={`font-bold tabular ${isIn ? 'text-brand-600' : 'text-rose-600'}`}>{isIn ? '+' : '−'} {money(p.amount)}</div>
          </button>
        )
      })}
    </Card>
  )
}
