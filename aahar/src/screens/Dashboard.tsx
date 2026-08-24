import { useNavigate } from 'react-router-dom'
import { useStore } from '@/lib/data/store'
import { dashboard, openReceivables, stockRows, saleTotal, partyName } from '@/lib/select'
import { money, moneyShort } from '@/lib/money'
import { fmtFull, relDue, TODAY } from '@/lib/date'
import { Card, Stat, Badge, SectionTitle, Button } from '@/components/ui'
import { Icon } from '@/components/icons'
import { receivableMeta } from '@/lib/status'

export function Dashboard() {
  const { state } = useStore()
  const nav = useNavigate()
  const d = dashboard(state)
  const recs = openReceivables(state)
    .filter((r) => r.status === 'overdue' || r.status === 'dueToday' || r.status === 'dueTomorrow')
    .sort((a, b) => a.daysToDue - b.daysToDue)
    .slice(0, 5)
  const lowStock = stockRows(state).filter((s) => s.low)
  const me = state.users.find((u) => u.id === state.currentUserId)

  return (
    <div className="space-y-6">
      <div className="wash -mx-4 -mt-5 rounded-b-3xl px-4 pb-2 pt-5 lg:mx-0 lg:mt-0 lg:rounded-3xl lg:px-6 lg:pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-ink-500">
              Namaste, <span className="font-semibold text-ink-700">{me?.name?.split(' ')[0]}</span> 👋
            </p>
            <h1 className="text-2xl font-bold text-ink-900">{state.business.name}</h1>
            <p className="hi text-sm text-ink-400">{state.business.hindi} · {fmtFull(TODAY)}</p>
          </div>
        </div>

        {/* Today strip */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Today's Sales" value={money(d.todaySales)} sub="बिक्री" tone="green" icon="sales" />
          <Stat label="Collections" value={money(d.todayCollections)} sub="वसूली" tone="blue" icon="rupee" />
          <Stat label="Cash in hand" value={money(d.cashInHand)} sub="रोकड़" tone="amber" icon="rokad" />
          <Stat label="Expenses" value={money(d.todayExpenses)} sub="खर्च" tone="gray" icon="expenses" />
        </div>
      </div>

      {/* Money that matters */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5">
          <SectionTitle>Receivables · वसूली</SectionTitle>
          <div className="text-3xl font-bold tabular text-ink-900">{money(d.totalReceivable)}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => nav('/payments')} className="rounded-xl bg-rose-50 px-3 py-2 text-left">
              <div className="text-xs font-semibold text-rose-600">Overdue</div>
              <div className="text-lg font-bold tabular text-rose-700">{money(d.overdue)}</div>
            </button>
            <button onClick={() => nav('/payments')} className="rounded-xl bg-amber-50 px-3 py-2 text-left">
              <div className="text-xs font-semibold text-amber-600">Due today</div>
              <div className="text-lg font-bold tabular text-amber-700">{money(d.dueToday)}</div>
            </button>
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle>Payable · देना</SectionTitle>
          <div className="text-3xl font-bold tabular text-ink-900">{money(d.totalPayable)}</div>
          <p className="mt-2 text-sm text-ink-500">Owed to suppliers across {state.parties.filter((p) => p.kind === 'supplier').length} accounts.</p>
          <Button variant="subtle" size="sm" className="mt-3" onClick={() => nav('/purchases')}>
            View purchases <Icon.chevron className="h-4 w-4" />
          </Button>
        </Card>

        <Card className="p-5">
          <SectionTitle>This month · इस माह</SectionTitle>
          <div className="text-3xl font-bold tabular text-ink-900">{moneyShort(d.monthSales)}</div>
          <p className="mt-2 text-sm text-ink-500">Sales in {TODAY.slice(0, 7)}. {state.sales.length} invoices total.</p>
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-lg bg-canvas px-3 py-2">
              <div className="font-bold tabular text-ink-900">{d.finishedBags.toLocaleString('en-IN')}</div>
              <div className="text-xs text-ink-500">bags in stock</div>
            </div>
            <div className="rounded-lg bg-canvas px-3 py-2">
              <div className="font-bold tabular text-ink-900">{d.pendingDispatch}</div>
              <div className="text-xs text-ink-500">pending dispatch</div>
            </div>
          </div>
        </Card>
      </div>

      {/* Attention needed */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle action={<button onClick={() => nav('/payments')} className="text-sm font-semibold text-brand-600">All</button>}>
            Needs collection
          </SectionTitle>
          {recs.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-400">Nothing due — all clear ✅</p>
          ) : (
            <div className="divide-y divide-line">
              {recs.map((r) => {
                const m = receivableMeta[r.status]
                return (
                  <button key={r.sale.id} onClick={() => nav('/customers/' + r.party.id)} className="flex w-full items-center gap-3 py-3 text-left">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold text-ink-900">{r.party.name}</div>
                      <div className="text-xs text-ink-400">{r.sale.no} · {relDue(r.dueDate)}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold tabular text-ink-900">{money(r.outstanding)}</div>
                      <Badge tone={m.tone}>{m.label}</Badge>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </Card>

        <Card className="p-5">
          <SectionTitle action={<button onClick={() => nav('/inventory')} className="text-sm font-semibold text-brand-600">All</button>}>
            Low stock alerts
          </SectionTitle>
          {lowStock.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-400">Stock levels healthy ✅</p>
          ) : (
            <div className="divide-y divide-line">
              {lowStock.map((s) => (
                <div key={s.product.id} className="flex items-center gap-3 py-3">
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-amber-50 text-amber-600">
                    <Icon.warn className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-ink-900">{s.product.name}</div>
                    <div className="hi text-xs text-ink-400">{s.product.hindi}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold tabular text-amber-700">{s.onHand.toLocaleString('en-IN')} {s.product.unit}</div>
                    <div className="text-xs text-ink-400">reorder {s.product.reorderLevel.toLocaleString('en-IN')}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Recent activity */}
      <Card className="p-5">
        <SectionTitle action={<button onClick={() => nav('/sales')} className="text-sm font-semibold text-brand-600">All sales</button>}>
          Recent sales
        </SectionTitle>
        <div className="divide-y divide-line">
          {state.sales.slice(0, 6).map((s) => (
            <div key={s.id} className="flex items-center gap-3 py-3">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-50 text-brand-600">
                <Icon.sales className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-ink-900">{partyName(state, s.partyId)}</div>
                <div className="text-xs text-ink-400">{s.no} · {relDue(s.date)}</div>
              </div>
              <div className="font-bold tabular text-ink-900">{money(saleTotal(s))}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
