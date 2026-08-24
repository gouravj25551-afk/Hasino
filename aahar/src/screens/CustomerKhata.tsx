import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '@/lib/data/store'
import { partyLedger, receivables } from '@/lib/select'
import { money } from '@/lib/money'
import { fmtDay, fmtFull, relDue } from '@/lib/date'
import { Card, Button, Badge, Avatar } from '@/components/ui'
import { Icon } from '@/components/icons'
import { PaymentSheet } from '@/components/PaymentSheet'
import { receivableMeta } from '@/lib/status'

export function CustomerKhata() {
  const { id } = useParams()
  const { state } = useStore()
  const nav = useNavigate()
  const [payOpen, setPayOpen] = useState(false)
  const [shared, setShared] = useState(false)

  const party = state.parties.find((p) => p.id === id)
  if (!party) return <div className="p-6 text-ink-500">Account not found.</div>

  const { rows, balance } = partyLedger(state, party.id)
  const isCustomer = party.kind === 'customer'
  const open = receivables(state).filter((r) => r.party.id === party.id && r.outstanding > 0.5)

  return (
    <div className="mx-auto max-w-3xl">
      <button onClick={() => nav('/customers')} className="no-print mb-3 inline-flex items-center gap-1 text-sm font-semibold text-ink-500 hover:text-ink-700">
        <Icon.back className="h-4 w-4" /> Khata
      </button>

      {/* Header */}
      <Card className="overflow-hidden">
        <div className="wash flex items-center gap-4 p-5">
          <Avatar name={party.name} className="h-14 w-14 text-lg" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold text-ink-900">{party.name}</h1>
            <p className="text-sm text-ink-500">{party.city} · {party.phone}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {party.gstin && <Badge tone="gray">GST {party.gstin}</Badge>}
              <Badge tone="blue">{party.creditDays}-day terms</Badge>
              {party.creditLimit ? <Badge tone="gray">Limit {money(party.creditLimit)}</Badge> : null}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 divide-x divide-line border-t border-line">
          <div className="p-4 text-center">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">{isCustomer ? 'Outstanding' : 'Payable'}</div>
            <div className={`text-2xl font-bold tabular ${balance > 0 ? 'text-rose-600' : 'text-brand-600'}`}>{money(Math.abs(balance))}</div>
          </div>
          <div className="p-4 text-center">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">Since</div>
            <div className="text-2xl font-bold tabular text-ink-900">{fmtDay(party.since)}</div>
            <div className="text-xs text-ink-400">{party.since.slice(0, 4)}</div>
          </div>
        </div>
      </Card>

      {party.notes && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <Icon.warn className="mt-0.5 h-4 w-4 shrink-0" /> {party.notes}
        </div>
      )}

      {/* Actions */}
      <div className="no-print mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Button size="lg" onClick={() => setPayOpen(true)}><Icon.rupee className="h-5 w-5" /> Payment</Button>
        <Button size="lg" variant="outline" onClick={() => { setShared(true); setTimeout(() => setShared(false), 2200) }}>
          <Icon.whatsapp className="h-5 w-5" /> {shared ? 'Sent ✓' : 'Statement'}
        </Button>
        <Button size="lg" variant="outline" onClick={() => window.print()}><Icon.print className="h-5 w-5" /> Print</Button>
        <a href={`tel:${party.phone.replace(/\s/g, '')}`} className="inline-flex h-14 items-center justify-center gap-2 rounded-xl border border-line bg-surface font-semibold text-ink-900 hover:bg-canvas">
          <Icon.phone className="h-5 w-5" /> Call
        </a>
      </div>

      {/* Open dues */}
      {isCustomer && open.length > 0 && (
        <Card className="mt-4 p-4">
          <div className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-500">Open invoices</div>
          <div className="divide-y divide-line">
            {open.map((r) => {
              const m = receivableMeta[r.status]
              return (
                <div key={r.sale.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-ink-900">{r.sale.no}</div>
                    <div className="text-xs text-ink-400">Due {fmtFull(r.dueDate)} · {relDue(r.dueDate)}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold tabular text-ink-900">{money(r.outstanding)}</div>
                    <Badge tone={m.tone}>{m.label}</Badge>
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Ledger */}
      <Card className="mt-4">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-sm font-bold uppercase tracking-wide text-ink-500">Statement · बही</div>
          <span className="text-xs text-ink-400">{rows.length} entries</span>
        </div>
        <div className="divide-y divide-line">
          {rows.slice().reverse().map((r, i) => {
            const credit = r.credit > 0
            return (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${credit ? 'bg-brand-50 text-brand-600' : 'bg-rose-50 text-rose-600'}`}>
                  {credit ? <Icon.arrowDown className="h-4 w-4" /> : <Icon.arrowUp className="h-4 w-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-ink-900">{r.particulars}</div>
                  <div className="text-xs text-ink-400">{fmtDay(r.date)} {r.ref ? `· ${r.ref}` : ''}</div>
                </div>
                <div className="text-right">
                  <div className={`font-bold tabular ${credit ? 'text-brand-600' : 'text-ink-900'}`}>
                    {credit ? '− ' : '+ '}{money(credit ? r.credit : r.debit)}
                  </div>
                  <div className="text-xs text-ink-400">bal {money(r.balance)}</div>
                </div>
              </div>
            )
          })}
        </div>
      </Card>

      <PaymentSheet open={payOpen} onClose={() => setPayOpen(false)} fixedPartyId={party.id} />
    </div>
  )
}
