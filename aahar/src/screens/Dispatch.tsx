import { useNavigate } from 'react-router-dom'
import { useStore } from '@/lib/data/store'
import { saleTotal, partyName } from '@/lib/select'
import type { Sale } from '@/lib/types'
import { money } from '@/lib/money'
import { fmtFull } from '@/lib/date'
import { Card, PageHeader, Badge, Button, Stat, SectionTitle, Empty } from '@/components/ui'
import { Icon } from '@/components/icons'

export function Dispatch() {
  const { state, dispatch } = useStore()
  const nav = useNavigate()

  const pending = state.sales.filter((s) => s.status === 'pending')
  const onRoad = state.sales.filter((s) => s.status === 'dispatched')
  const delivered = state.sales.filter((s) => s.status === 'delivered').slice(0, 6)

  return (
    <div>
      <PageHeader title="Dispatch" hindi="डिस्पैच" sub="Loading, trucks, drivers and delivery status." />

      <div className="mb-4 grid grid-cols-3 gap-3">
        <Stat label="To load" value={pending.length} sub="pending" tone="amber" icon="box" />
        <Stat label="On the road" value={onRoad.length} sub="dispatched" tone="blue" icon="truck" />
        <Stat label="Transport" value={money(state.sales.reduce((s, x) => s + (x.transportCost ?? 0), 0))} sub="cost logged" tone="gray" icon="rupee" />
      </div>

      {pending.length > 0 && (
        <>
          <SectionTitle>Ready to load · लोडिंग बाकी</SectionTitle>
          <div className="mb-5 space-y-3">
            {pending.map((s) => (
              <DispatchCard key={s.id} sale={s} onAdvance={() => dispatch({ type: 'setStatus', saleId: s.id, status: 'dispatched' })} advanceLabel="Mark dispatched" />
            ))}
          </div>
        </>
      )}

      <SectionTitle>On the road · रवाना</SectionTitle>
      {onRoad.length === 0 ? (
        <Card className="mb-5"><Empty icon="truck" title="No trucks out" /></Card>
      ) : (
        <div className="mb-5 space-y-3">
          {onRoad.map((s) => (
            <DispatchCard key={s.id} sale={s} onAdvance={() => dispatch({ type: 'setStatus', saleId: s.id, status: 'delivered' })} advanceLabel="Confirm delivered" onParchi={() => nav('/parchi/' + s.id)} />
          ))}
        </div>
      )}

      <SectionTitle>Recently delivered</SectionTitle>
      <Card className="divide-y divide-line">
        {delivered.map((s) => (
          <div key={s.id} className="flex items-center gap-3 px-4 py-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-50 text-brand-600"><Icon.check className="h-4 w-4" /></span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold text-ink-900">{partyName(state, s.partyId)}</div>
              <div className="text-xs text-ink-400">{s.no} · {s.vehicle ?? 'own delivery'} · {fmtFull(s.date)}</div>
            </div>
            <div className="font-bold tabular text-ink-900">{money(saleTotal(s))}</div>
          </div>
        ))}
      </Card>
    </div>
  )
}

function DispatchCard({ sale, onAdvance, advanceLabel, onParchi }: { sale: Sale; onAdvance: () => void; advanceLabel: string; onParchi?: () => void }) {
  const { state } = useStore()
  const bags = sale.lines.reduce((s, l) => s + l.qty, 0)
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-lg bg-brand-50 text-brand-600"><Icon.truck className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-bold text-ink-900">{partyName(state, sale.partyId)}</span>
            <Badge tone={sale.status === 'pending' ? 'amber' : 'blue'}>{sale.status}</Badge>
          </div>
          <div className="text-sm text-ink-500">{sale.no} · {bags} bags · {money(saleTotal(sale))}</div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-400">
            <span>🚚 {sale.vehicle ?? 'Not assigned'}</span>
            <span>👤 {sale.driver ?? '—'}{sale.driverPhone ? ` · ${sale.driverPhone}` : ''}</span>
            {sale.transportCost ? <span>💰 Transport {money(sale.transportCost)}</span> : null}
          </div>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={onAdvance}><Icon.check className="h-4 w-4" /> {advanceLabel}</Button>
        {onParchi && <Button size="sm" variant="outline" onClick={onParchi}><Icon.print className="h-4 w-4" /> Parchi</Button>}
      </div>
    </Card>
  )
}
