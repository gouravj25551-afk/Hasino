import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore, newId, nextPurchaseNo } from '@/lib/data/store'
import { useLang } from '@/lib/lang'
import { lineTotal, partyName, outstanding } from '@/lib/select'
import type { PayMode, PurchaseLine } from '@/lib/types'
import { money } from '@/lib/money'
import { fmtFull, addDays, relDue, TODAY } from '@/lib/date'
import { Card, PageHeader, Badge, Stat, SectionTitle, Button, Sheet, Field, Input, Select } from '@/components/ui'
import { Icon } from '@/components/icons'
import { payModes, modeKey, pname } from '@/lib/labels'

export function Purchases() {
  const { state } = useStore()
  const { t, lang } = useLang()
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  const purchases = state.purchases.slice().sort((a, b) => (a.date < b.date ? 1 : -1))
  const payable = state.parties.filter((p) => p.kind === 'supplier').reduce((s, p) => s + Math.max(0, outstanding(state, p.id)), 0)
  const monthSpend = purchases.filter((p) => p.date.startsWith(TODAY.slice(0, 7))).reduce((s, p) => s + lineTotal(p.lines), 0)

  return (
    <div>
      <PageHeader title={t('pur.title')} sub={t('pur.sub')}
        action={<Button className="hidden sm:inline-flex" onClick={() => setOpen(true)}><Icon.plus className="h-5 w-5" /> {t('pur.new')}</Button>} />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label={t('pur.totalPayable')} value={money(payable)} tone="red" icon="rupee" />
        <Stat label={t('pur.thisMonth')} value={money(monthSpend)} tone="blue" icon="purchase" />
        <Stat label={t('pur.suppliers')} value={state.parties.filter((p) => p.kind === 'supplier').length} tone="gray" icon="users" />
      </div>

      <SectionTitle>{t('pur.recent')}</SectionTitle>
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
                  {bal > 0 ? <Badge tone="amber">{t('common.balance')} {money(bal)}</Badge> : <Badge tone="green">{t('common.paid')}</Badge>}
                </div>
                <div className="truncate text-sm text-ink-500">{partyName(state, p.partyId)}</div>
                <div className="truncate text-xs text-ink-400">{p.lines.map((l) => `${l.qty.toLocaleString('en-IN')}kg ${pname(state.products.find((x) => x.id === l.productId), lang)}`).join(', ')}</div>
                <div className="text-xs text-ink-400">{fmtFull(p.date)} · {t('common.due')} {relDue(due, lang)}{supplier?.gstin ? ` · ${supplier.gstin}` : ''}</div>
              </div>
              <div className="font-bold tabular text-ink-900">{money(gross)}</div>
            </button>
          )
        })}
      </Card>

      <div className="no-print fixed bottom-24 right-4 z-30 sm:hidden">
        <button onClick={() => setOpen(true)} className="grid h-14 w-14 place-items-center rounded-full bg-brand-600 text-white shadow-lg"><Icon.plus className="h-6 w-6" /></button>
      </div>

      {open && <PurchaseSheet onClose={() => setOpen(false)} />}
    </div>
  )
}

function PurchaseSheet({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore()
  const { t, lang } = useLang()
  const suppliers = state.parties.filter((p) => p.kind === 'supplier')
  const raws = state.products.filter((p) => p.type === 'raw')

  const [partyId, setPartyId] = useState('')
  const [lines, setLines] = useState<PurchaseLine[]>([{ productId: raws[0]?.id ?? '', qty: 0, unit: 'kg', rate: raws[0]?.rate ?? 0 }])
  const [creditDays, setCreditDays] = useState(15)
  const [paidNow, setPaidNow] = useState(0)
  const [paidMode, setPaidMode] = useState<PayMode>('bank')

  const total = lines.reduce((s, l) => s + l.qty * l.rate, 0)
  const canSave = !!partyId && total > 0 && lines.every((l) => l.productId && l.qty > 0)

  function setLine(i: number, patch: Partial<PurchaseLine>) { setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l))) }
  function pick(i: number, productId: string) { const p = raws.find((x) => x.id === productId); setLine(i, { productId, rate: p?.rate ?? 0 }) }

  function save() {
    if (!canSave) return
    dispatch({ type: 'addPurchase', purchase: { id: newId('pu'), no: nextPurchaseNo(state), partyId, date: TODAY, lines, creditDays, paidNow, paidMode: paidNow > 0 ? paidMode : undefined, createdBy: state.currentUserId } })
    onClose()
  }

  return (
    <Sheet open onClose={onClose} title={t('pur.new')} wide footer={<Button full size="lg" disabled={!canSave} onClick={save}>{t('pur.save', { amt: money(total) })}</Button>}>
      <div className="space-y-4">
        <Field label={t('pur.supplier')}>
          <Select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">{t('pur.selectSupplier')}</option>
            {suppliers.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
          </Select>
        </Field>
        <div className="space-y-3">
          {lines.map((l, i) => (
            <div key={i} className="rounded-2xl border border-line p-3">
              <div className="flex items-center gap-2">
                <Select value={l.productId} onChange={(e) => pick(i, e.target.value)} className="flex-1">
                  {raws.map((rp) => (<option key={rp.id} value={rp.id}>{pname(rp, lang)}</option>))}
                </Select>
                {lines.length > 1 && <button onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-ink-400 hover:bg-canvas"><Icon.close className="h-5 w-5" /></button>}
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <Field label={t('pur.qtyKg')}><Input type="number" inputMode="numeric" value={l.qty || ''} onChange={(e) => setLine(i, { qty: Number(e.target.value) })} placeholder="0" /></Field>
                <Field label={t('pur.rateKg')}><Input type="number" inputMode="numeric" value={l.rate || ''} onChange={(e) => setLine(i, { rate: Number(e.target.value) })} /></Field>
                <Field label={t('sale.amount')}><div className="flex h-12 items-center rounded-xl bg-canvas px-3 font-bold tabular text-ink-900">{money(l.qty * l.rate)}</div></Field>
              </div>
            </div>
          ))}
          <button onClick={() => setLines((ls) => [...ls, { productId: raws[0]?.id ?? '', qty: 0, unit: 'kg', rate: raws[0]?.rate ?? 0 }])} className="inline-flex items-center gap-1 text-sm font-semibold text-brand-600"><Icon.plus className="h-4 w-4" /> {t('sale.addItem')}</button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('sale.creditDays')}><Input type="number" inputMode="numeric" value={creditDays} onChange={(e) => setCreditDays(Number(e.target.value))} /></Field>
          <Field label={t('sale.paidNow')}><Input type="number" inputMode="numeric" value={paidNow || ''} onChange={(e) => setPaidNow(Number(e.target.value))} placeholder="0" /></Field>
        </div>
        {paidNow > 0 && (
          <div className="flex flex-wrap gap-2">
            {payModes.map((m) => (<button key={m} onClick={() => setPaidMode(m)} className={`rounded-xl border px-3 py-2 text-sm font-semibold ${paidMode === m ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-line text-ink-500'}`}>{t(modeKey[m])}</button>))}
          </div>
        )}
      </div>
    </Sheet>
  )
}
