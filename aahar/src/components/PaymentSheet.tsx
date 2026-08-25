import { useState } from 'react'
import { useStore, newId } from '@/lib/data/store'
import { useLang } from '@/lib/lang'
import type { PayMode, Party, Payment } from '@/lib/types'
import { TODAY } from '@/lib/date'
import { money } from '@/lib/money'
import { outstanding } from '@/lib/select'
import { Sheet, Button, Field, Input, Select } from '@/components/ui'
import { payModes, modeKey } from '@/lib/labels'

export function PaymentSheet({ open, onClose, fixedPartyId, existing }: { open: boolean; onClose: () => void; fixedPartyId?: string; existing?: Payment }) {
  const { state, dispatch } = useStore()
  const { t } = useLang()
  const [partyId, setPartyId] = useState(existing?.partyId ?? fixedPartyId ?? '')
  const [amount, setAmount] = useState(existing?.amount ?? 0)
  const [mode, setMode] = useState<PayMode>(existing?.mode ?? 'upi')
  const [ref, setRef] = useState(existing?.ref ?? '')
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')

  const party: Party | undefined = state.parties.find((p) => p.id === (existing?.partyId ?? fixedPartyId ?? partyId))
  const direction = existing?.direction ?? (party?.kind === 'supplier' ? 'out' : 'in')
  const bal = party ? outstanding(state, party.id) : 0

  function reset() {
    setPartyId(fixedPartyId ?? ''); setAmount(0); setMode('upi'); setRef(''); setReason(''); setErr('')
  }

  function save() {
    if (!party) { setErr(t('pay.selectParty')); return }
    if (amount <= 0) { setErr(t('common.mustBePositive')); return }
    if (existing) {
      dispatch({ type: 'updatePayment', payment: { ...existing, amount, mode, ref: ref || undefined }, oldAmount: existing.amount, reason: reason || undefined })
    } else {
      dispatch({ type: 'addPayment', payment: { id: newId('pm'), partyId: party.id, direction, amount, mode, date: TODAY, ref: ref || undefined, createdBy: state.currentUserId } })
    }
    reset(); onClose()
  }

  const title = existing ? t('pay.editTitle') : direction === 'out' ? t('pay.paySupplier') : t('pay.record')
  const cta = direction === 'out' ? t('pay.saveOut', { amt: money(amount) }) : t('pay.saveIn', { amt: money(amount) })

  return (
    <Sheet open={open} onClose={() => { reset(); onClose() }} title={title} footer={<Button full size="lg" onClick={save}>{existing ? t('common.save') : cta}</Button>}>
      <div className="space-y-4">
        {!fixedPartyId && !existing && (
          <Field label={t('pay.party')}>
            <Select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
              <option value="">{t('pay.selectParty')}</option>
              {state.parties.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
            </Select>
          </Field>
        )}
        {party && (
          <div className="rounded-xl bg-canvas px-4 py-3 text-sm">
            <span className="text-ink-500">{direction === 'out' ? t('pay.currentPay') : t('pay.currentOut')}: </span>
            <span className="font-bold tabular text-ink-900">{money(Math.abs(bal))}</span>
          </div>
        )}
        <Field label={t('pay.amount')}>
          <Input type="number" inputMode="numeric" autoFocus min={0} value={amount || ''} onChange={(e) => { setAmount(Number(e.target.value)); setErr('') }} placeholder="0" />
          {err && <div className="mt-1 text-xs font-semibold text-rose-600">{err}</div>}
        </Field>
        {party && bal > 0 && !existing && (
          <button className="text-sm font-semibold text-brand-600" onClick={() => setAmount(Math.max(0, Math.round(bal)))}>
            {t('pay.fullAmount', { amt: money(Math.abs(bal)) })}
          </button>
        )}
        <Field label={t('pay.mode')}>
          <div className="flex flex-wrap gap-2">
            {payModes.map((m) => (
              <button key={m} onClick={() => setMode(m)} className={`rounded-xl border px-3 py-2 text-sm font-semibold ${mode === m ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-line text-ink-500'}`}>{t(modeKey[m])}</button>
            ))}
          </div>
        </Field>
        <Field label={t('pay.ref')} hint={t('pay.refHint')}><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        {existing && (
          <Field label={t('pay.editReason')} hint={t('pay.editReasonHint')}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        )}
      </div>
    </Sheet>
  )
}
