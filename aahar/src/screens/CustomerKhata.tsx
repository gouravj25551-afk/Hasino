import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '@/lib/data/store'
import { useLang } from '@/lib/lang'
import { partyLedger, receivables } from '@/lib/select'
import { money } from '@/lib/money'
import { fmtDay, fmtFull, relDue } from '@/lib/date'
import { Card, Button, Badge, Avatar } from '@/components/ui'
import { Icon } from '@/components/icons'
import { PaymentSheet } from '@/components/PaymentSheet'
import { PartyForm } from '@/components/PartyForm'
import { statusKey, receivableTone } from '@/lib/labels'

// Map ledger particulars (English) to a translation where possible.
function useLedgerLabel() {
  const { t } = useLang()
  return (particulars: string, ref?: string): string => {
    if (particulars === 'Opening balance') return t('led.opening')
    if (particulars.startsWith('Payment received')) return t('led.paymentReceived')
    if (particulars.startsWith('Payment made')) return t('led.paymentMade')
    if (particulars.startsWith('Paid at sale')) return t('led.paidAtSale')
    if (particulars.startsWith('Paid on purchase')) return t('led.paidAtSale')
    if (particulars.startsWith('Purchase')) return `${t('led.purchase')} ${ref ?? ''}`.trim()
    return particulars
  }
}

export function CustomerKhata() {
  const { id } = useParams()
  const { state, dispatch } = useStore()
  const { t, lang } = useLang()
  const nav = useNavigate()
  const [payOpen, setPayOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [shared, setShared] = useState(false)
  const ledgerLabel = useLedgerLabel()

  const party = state.parties.find((p) => p.id === id)
  if (!party) return <div className="p-6 text-ink-500">{t('cust.notFound')}</div>

  const { rows, balance } = partyLedger(state, party.id)
  const isCustomer = party.kind === 'customer'
  const open = receivables(state).filter((r) => r.party.id === party.id && r.outstanding > 0.5)

  function remove() {
    if (confirm(t('cust.deleteConfirm'))) { dispatch({ type: 'deleteParty', id: party!.id }); nav('/customers') }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print mb-3 flex items-center justify-between">
        <button onClick={() => nav('/customers')} className="inline-flex items-center gap-1 text-sm font-semibold text-ink-500 hover:text-ink-700"><Icon.back className="h-4 w-4" /> {t('cust.title')}</button>
        <div className="flex gap-1">
          <button onClick={() => setEditOpen(true)} className="grid h-9 w-9 place-items-center rounded-lg text-ink-500 hover:bg-canvas" aria-label={t('common.edit')}><Icon.settings className="h-5 w-5" /></button>
          <button onClick={remove} className="grid h-9 w-9 place-items-center rounded-lg text-rose-500 hover:bg-rose-50" aria-label={t('common.delete')}><Icon.close className="h-5 w-5" /></button>
        </div>
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center gap-4 p-5">
          <Avatar name={party.name} className="h-14 w-14 text-lg" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold text-ink-900">{party.name}</h1>
            <p className="text-sm text-ink-500">{party.city}{party.city && party.phone ? ' · ' : ''}{party.phone}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {party.gstin && <Badge tone="gray">GST {party.gstin}</Badge>}
              <Badge tone="blue">{t('cust.terms', { n: party.creditDays })}</Badge>
              {party.creditLimit ? <Badge tone="gray">{t('sale.limit', { amt: money(party.creditLimit) })}</Badge> : null}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 divide-x divide-line border-t border-line">
          <div className="p-4 text-center">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">{isCustomer ? t('cust.outstanding') : t('cust.payable')}</div>
            <div className={`text-2xl font-bold tabular ${balance > 0 ? 'text-rose-600' : 'text-brand-600'}`}>{money(Math.abs(balance))}</div>
          </div>
          <div className="p-4 text-center">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">{t('cust.since')}</div>
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

      <div className="no-print mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Button size="lg" onClick={() => setPayOpen(true)}><Icon.rupee className="h-5 w-5" /> {t('cust.payment')}</Button>
        <Button size="lg" variant="outline" onClick={() => { setShared(true); setTimeout(() => setShared(false), 2200) }}>
          <Icon.whatsapp className="h-5 w-5" /> {shared ? t('common.saved') + ' ✓' : t('cust.statement')}
        </Button>
        <Button size="lg" variant="outline" onClick={() => window.print()}><Icon.print className="h-5 w-5" /> {t('common.print')}</Button>
        <a href={`tel:${party.phone.replace(/\s/g, '')}`} className="inline-flex h-14 items-center justify-center gap-2 rounded-xl border border-line bg-surface font-semibold text-ink-900 hover:bg-canvas">
          <Icon.phone className="h-5 w-5" /> {t('common.call')}
        </a>
      </div>

      {isCustomer && open.length > 0 && (
        <Card className="mt-4 p-4">
          <div className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-500">{t('cust.openInvoices')}</div>
          <div className="divide-y divide-line">
            {open.map((r) => (
              <div key={r.sale.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-ink-900">{r.sale.no}</div>
                  <div className="text-xs text-ink-400">{t('common.due')} {fmtFull(r.dueDate)} · {relDue(r.dueDate, lang)}</div>
                </div>
                <div className="text-right">
                  <div className="font-bold tabular text-ink-900">{money(r.outstanding)}</div>
                  <Badge tone={receivableTone[r.status]}>{t(statusKey[r.status])}</Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="mt-4">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-sm font-bold uppercase tracking-wide text-ink-500">{t('cust.statementTitle')}</div>
          <span className="text-xs text-ink-400">{t('cust.entries', { n: rows.length })}</span>
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
                  <div className="truncate font-semibold text-ink-900">{ledgerLabel(r.particulars, r.ref)}</div>
                  <div className="text-xs text-ink-400">{fmtDay(r.date)} {r.ref ? `· ${r.ref}` : ''}</div>
                </div>
                <div className="text-right">
                  <div className={`font-bold tabular ${credit ? 'text-brand-600' : 'text-ink-900'}`}>{credit ? '− ' : '+ '}{money(credit ? r.credit : r.debit)}</div>
                  <div className="text-xs text-ink-400">{t('led.bal', { amt: money(r.balance) })}</div>
                </div>
              </div>
            )
          })}
        </div>
      </Card>

      <PaymentSheet open={payOpen} onClose={() => setPayOpen(false)} fixedPartyId={party.id} />
      {editOpen && <PartyForm open={editOpen} onClose={() => setEditOpen(false)} kind={party.kind} existing={party} />}
    </div>
  )
}
