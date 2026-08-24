import { useNavigate } from 'react-router-dom'
import { useStore } from '@/lib/data/store'
import { lineTotal, partyName, productName, outstanding } from '@/lib/select'
import { money } from '@/lib/money'
import { fmtFull, addDays, relDue, TODAY } from '@/lib/date'
import { Card, PageHeader, Badge, Stat, SectionTitle } from '@/components/ui'
import { Icon } from '@/components/icons'

export function Purchases() {
  const { state } = useStore()
  const nav = useNavigate()
  const purchases = state.purchases.slice().sort((a, b) => (a.date < b.date ? 1 : -1))
  const payable = state.parties.filter((p) => p.kind === 'supplier').reduce((s, p) => s + Math.max(0, outstanding(state, p.id)), 0)
  const monthSpend = purchases.filter((p) => p.date.startsWith(TODAY.slice(0, 7))).reduce((s, p) => s + lineTotal(p.lines), 0)

  return (
    <div>
      <PageHeader title="Purchases" hindi="खरीद" sub="Raw-material buying and supplier dues." />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Total payable" value={money(payable)} sub="to suppliers" tone="red" icon="rupee" />
        <Stat label="This month" value={money(monthSpend)} sub="purchases" tone="blue" icon="purchase" />
        <Stat label="Suppliers" value={state.parties.filter((p) => p.kind === 'supplier').length} sub="accounts" tone="gray" icon="users" />
      </div>

      <SectionTitle>Recent purchases</SectionTitle>
      <Card className="divide-y divide-line">
        {purchases.map((p) => {
          const supplier = state.parties.find((x) => x.id === p.partyId)
          const gross = lineTotal(p.lines)
          const bal = gross - p.paidNow
          const due = addDays(p.date, p.creditDays)
          return (
            <button key={p.id} onClick={() => nav('/customers/' + p.partyId)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-canvas">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-600"><Icon.inventory className="h-5 w-5" /></span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-ink-900">{p.no}</span>
                  {bal > 0 ? <Badge tone="amber">Bal {money(bal)}</Badge> : <Badge tone="green">Paid</Badge>}
                </div>
                <div className="truncate text-sm text-ink-500">{partyName(state, p.partyId)}</div>
                <div className="text-xs text-ink-400">
                  {p.lines.map((l) => `${l.qty.toLocaleString('en-IN')}kg ${productName(state, l.productId)}`).join(', ')}
                </div>
                <div className="text-xs text-ink-400">{fmtFull(p.date)} · due {relDue(due)}{supplier?.gstin ? ` · ${supplier.gstin}` : ''}</div>
              </div>
              <div className="font-bold tabular text-ink-900">{money(gross)}</div>
            </button>
          )
        })}
      </Card>
    </div>
  )
}
