import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore, newId, nextInvoiceNo } from '@/lib/data/store'
import type { PayMode, SaleLine } from '@/lib/types'
import { money } from '@/lib/money'
import { TODAY, addDays, fmtFull } from '@/lib/date'
import { outstanding, stockRows } from '@/lib/select'
import { Card, Button, Field, Input, Select, Badge, PageHeader } from '@/components/ui'
import { Icon } from '@/components/icons'
import { payModes, payModeLabel } from '@/lib/status'

export function NewSale() {
  const { state, dispatch } = useStore()

  const customers = state.parties.filter((p) => p.kind === 'customer')
  const finished = state.products.filter((p) => p.type === 'finished')
  const stock = useMemo(() => Object.fromEntries(stockRows(state, 'finished').map((s) => [s.product.id, s.onHand])), [state])

  const [partyId, setPartyId] = useState('')
  const [lines, setLines] = useState<SaleLine[]>([{ productId: finished[0]?.id ?? '', qty: 0, unit: 'bag', rate: finished[0]?.rate ?? 0 }])
  const [creditDays, setCreditDays] = useState(4)
  const [paidNow, setPaidNow] = useState(0)
  const [paidMode, setPaidMode] = useState<PayMode>('cash')
  const [vehicle, setVehicle] = useState('')
  const [driver, setDriver] = useState('')
  const [note, setNote] = useState('')
  const [savedId, setSavedId] = useState<string | null>(null)

  const party = customers.find((p) => p.id === partyId)
  const total = lines.reduce((s, l) => s + l.qty * l.rate, 0)
  const dueDate = addDays(TODAY, creditDays)
  const curOutstanding = party ? outstanding(state, party.id) : 0
  const overLimit = party?.creditLimit ? curOutstanding + (total - paidNow) > party.creditLimit : false

  function setLine(i: number, patch: Partial<SaleLine>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }
  function pickProduct(i: number, productId: string) {
    const p = finished.find((x) => x.id === productId)
    setLine(i, { productId, rate: p?.rate ?? 0 })
  }
  function addLine() {
    const p = finished[0]
    setLines((ls) => [...ls, { productId: p?.id ?? '', qty: 0, unit: 'bag', rate: p?.rate ?? 0 }])
  }
  function removeLine(i: number) {
    setLines((ls) => (ls.length > 1 ? ls.filter((_, idx) => idx !== i) : ls))
  }

  const canSave = !!partyId && total > 0 && lines.every((l) => l.productId && l.qty > 0)

  function save() {
    if (!canSave) return
    const id = newId('sl')
    const no = nextInvoiceNo(state)
    dispatch({
      type: 'addSale',
      sale: {
        id, no, partyId, date: TODAY, lines, creditDays,
        paidNow, paidMode: paidNow > 0 ? paidMode : undefined,
        vehicle: vehicle || undefined, driver: driver || undefined,
        status: vehicle ? 'dispatched' : 'pending',
        note: note || undefined, createdBy: state.currentUserId,
      },
    })
    setSavedId(id)
  }

  if (savedId) {
    const sale = state.sales.find((s) => s.id === savedId)
    const no = sale?.no ?? nextInvoiceNo(state)
    return <SaleDone no={no} savedId={savedId} total={total} paidNow={paidNow} dueDate={dueDate} partyName={party?.name ?? ''} onNew={() => {
      setSavedId(null); setPartyId(''); setLines([{ productId: finished[0]?.id ?? '', qty: 0, unit: 'bag', rate: finished[0]?.rate ?? 0 }]); setPaidNow(0); setVehicle(''); setDriver(''); setNote('')
    }} />
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="New Sale" hindi="नई बिक्री" sub="One entry updates stock, khata, dues, dispatch & rokad." />

      <div className="space-y-4">
        <Card className="p-4 sm:p-5">
          <Field label="Customer · ग्राहक">
            <Select value={partyId} onChange={(e) => { setPartyId(e.target.value); const c = customers.find((x) => x.id === e.target.value); if (c) setCreditDays(c.creditDays) }}>
              <option value="">Select customer…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name} · {c.city}</option>
              ))}
            </Select>
          </Field>
          {party && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={curOutstanding > 0 ? 'amber' : 'green'}>Outstanding {money(curOutstanding)}</Badge>
              {party.creditLimit ? <Badge tone="gray">Limit {money(party.creditLimit)}</Badge> : null}
              <Badge tone="blue">{party.creditDays}-day credit</Badge>
            </div>
          )}
        </Card>

        <Card className="p-4 sm:p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-bold uppercase tracking-wide text-ink-500">Items · माल</div>
            <button onClick={addLine} className="inline-flex items-center gap-1 text-sm font-semibold text-brand-600">
              <Icon.plus className="h-4 w-4" /> Add item
            </button>
          </div>
          <div className="space-y-3">
            {lines.map((l, i) => {
              const p = finished.find((x) => x.id === l.productId)
              const onHand = stock[l.productId] ?? 0
              const short = l.qty > onHand
              return (
                <div key={i} className="rounded-2xl border border-line p-3">
                  <div className="flex items-center gap-2">
                    <Select value={l.productId} onChange={(e) => pickProduct(i, e.target.value)} className="flex-1">
                      {finished.map((fp) => (
                        <option key={fp.id} value={fp.id}>{fp.name}</option>
                      ))}
                    </Select>
                    {lines.length > 1 && (
                      <button onClick={() => removeLine(i)} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-ink-400 hover:bg-canvas">
                        <Icon.close className="h-5 w-5" />
                      </button>
                    )}
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <Field label="Bags">
                      <Input type="number" inputMode="numeric" min={0} value={l.qty || ''} onChange={(e) => setLine(i, { qty: Number(e.target.value) })} placeholder="0" />
                    </Field>
                    <Field label="Rate/bag">
                      <Input type="number" inputMode="numeric" min={0} value={l.rate || ''} onChange={(e) => setLine(i, { rate: Number(e.target.value) })} />
                    </Field>
                    <Field label="Amount">
                      <div className="flex h-12 items-center rounded-xl bg-canvas px-3 font-bold tabular text-ink-900">{money(l.qty * l.rate)}</div>
                    </Field>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-xs">
                    <span className="text-ink-400">In stock: {onHand.toLocaleString('en-IN')} bags {p ? `(${p.packKg}kg each)` : ''}</span>
                    {short && <span className="font-semibold text-rose-600">⚠ Only {onHand} in stock</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </Card>

        <Card className="p-4 sm:p-5">
          <div className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-500">Payment terms · भुगतान</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Credit days" hint={`Due ${fmtFull(dueDate)}`}>
              <Input type="number" inputMode="numeric" min={0} value={creditDays} onChange={(e) => setCreditDays(Number(e.target.value))} />
            </Field>
            <Field label="Paid now (optional)">
              <Input type="number" inputMode="numeric" min={0} value={paidNow || ''} onChange={(e) => setPaidNow(Number(e.target.value))} placeholder="0" />
            </Field>
          </div>
          {paidNow > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {payModes.map((m) => (
                <button key={m} onClick={() => setPaidMode(m)} className={`rounded-xl border px-3 py-2 text-sm font-semibold ${paidMode === m ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-line text-ink-500'}`}>
                  {payModeLabel[m]}
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-4 sm:p-5">
          <div className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-500">Truck & driver · गाड़ी (optional)</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Vehicle no."><Input value={vehicle} onChange={(e) => setVehicle(e.target.value.toUpperCase())} placeholder="RJ13 GA 4521" /></Field>
            <Field label="Driver"><Input value={driver} onChange={(e) => setDriver(e.target.value)} placeholder="Name" /></Field>
          </div>
          <Field label="Note" className="mt-3"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Any remark for this parchi" /></Field>
        </Card>

        {overLimit && (
          <div className="flex items-center gap-2 rounded-xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
            <Icon.warn className="h-5 w-5 shrink-0" /> This sale pushes {party?.name} over their credit limit.
          </div>
        )}
      </div>

      {/* Sticky total + save */}
      <div className="sticky bottom-20 z-20 mt-5 lg:bottom-4">
        <Card className="flex items-center gap-4 p-4 shadow-lg">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">Total</div>
            <div className="text-2xl font-bold tabular text-ink-900">{money(total)}</div>
            {paidNow > 0 && <div className="text-xs text-ink-400">Balance {money(total - paidNow)} · due {fmtFull(dueDate)}</div>}
          </div>
          <Button size="lg" className="ml-auto flex-1 sm:flex-none" disabled={!canSave} onClick={save}>
            <Icon.check className="h-5 w-5" /> Save sale
          </Button>
        </Card>
      </div>
    </div>
  )
}

function SaleDone({ no, savedId, total, paidNow, dueDate, partyName, onNew }: { no: string; savedId: string; total: number; paidNow: number; dueDate: string; partyName: string; onNew: () => void }) {
  const nav = useNavigate()
  const steps = [
    { icon: 'sales' as const, text: `Invoice ${no} created` },
    { icon: 'inventory' as const, text: 'Finished-goods stock reduced' },
    { icon: 'khata' as const, text: `${partyName}'s khata debited ${money(total)}` },
    { icon: 'rupee' as const, text: paidNow > 0 ? `${money(paidNow)} received · balance ${money(total - paidNow)}` : `Receivable created — due ${fmtFull(dueDate)}` },
    { icon: 'bell' as const, text: 'Payment reminder scheduled' },
    { icon: 'dispatch' as const, text: 'Dispatch record ready' },
    { icon: 'rokad' as const, text: 'Daily rokad & dashboard updated' },
  ]
  return (
    <div className="mx-auto max-w-lg pt-6 text-center">
      <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-brand-100 text-brand-700 rise">
        <Icon.check className="h-9 w-9" />
      </div>
      <h1 className="mt-4 text-2xl font-bold text-ink-900">Sale saved</h1>
      <p className="text-ink-500">{no} · {partyName} · {money(total)}</p>

      <Card className="mt-5 p-5 text-left">
        <div className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-500">One entry updated everything</div>
        <ul className="space-y-2.5">
          {steps.map((s, i) => {
            const I = Icon[s.icon]
            return (
              <li key={i} className="flex items-center gap-3">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-600"><I className="h-4 w-4" /></span>
                <span className="text-sm font-medium text-ink-700">{s.text}</span>
                <Icon.check className="ml-auto h-4 w-4 text-brand-500" />
              </li>
            )
          })}
        </ul>
      </Card>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <Button size="lg" onClick={() => nav('/parchi/' + savedId)}><Icon.print className="h-5 w-5" /> Parchi</Button>
        <Button size="lg" variant="outline" onClick={onNew}><Icon.plus className="h-5 w-5" /> New sale</Button>
      </div>
      <button onClick={() => nav('/sales')} className="mt-3 text-sm font-semibold text-brand-600">Go to sales history</button>
    </div>
  )
}
