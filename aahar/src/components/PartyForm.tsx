import { useState } from 'react'
import { useStore, newId } from '@/lib/data/store'
import { useLang } from '@/lib/lang'
import type { Party, PartyKind } from '@/lib/types'
import { TODAY } from '@/lib/date'
import { Sheet, Button, Field, Input, Textarea } from '@/components/ui'

export function PartyForm({ open, onClose, kind, existing }: { open: boolean; onClose: () => void; kind: PartyKind; existing?: Party }) {
  const { dispatch } = useStore()
  const { t } = useLang()
  const [name, setName] = useState(existing?.name ?? '')
  const [phone, setPhone] = useState(existing?.phone ?? '')
  const [city, setCity] = useState(existing?.city ?? '')
  const [gstin, setGstin] = useState(existing?.gstin ?? '')
  const [opening, setOpening] = useState(existing?.openingBalance ?? 0)
  const [limit, setLimit] = useState(existing?.creditLimit ?? 0)
  const [days, setDays] = useState(existing?.creditDays ?? 7)
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [err, setErr] = useState('')

  function save() {
    if (!name.trim()) { setErr(t('common.required')); return }
    const party: Party = {
      id: existing?.id ?? newId(kind === 'customer' ? 'c' : 's'),
      kind,
      name: name.trim(),
      phone: phone.trim(),
      city: city.trim(),
      gstin: gstin.trim() || undefined,
      openingBalance: opening || 0,
      creditLimit: limit || undefined,
      creditDays: days || 0,
      notes: notes.trim() || undefined,
      since: existing?.since ?? TODAY,
    }
    dispatch(existing ? { type: 'updateParty', party } : { type: 'addParty', party })
    onClose()
  }

  const title = existing ? t('cust.editParty') : kind === 'customer' ? t('cust.addCustomer') : t('cust.addSupplier')

  return (
    <Sheet open={open} onClose={onClose} title={title} footer={<Button full size="lg" onClick={save}>{t('common.save')}</Button>}>
      <div className="space-y-4">
        <Field label={t('cust.name')}>
          <Input value={name} autoFocus onChange={(e) => { setName(e.target.value); setErr('') }} placeholder={t('cust.name')} />
          {err && <div className="mt-1 text-xs font-semibold text-rose-600">{err}</div>}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('cust.phone')}><Input value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value)} placeholder="+91" /></Field>
          <Field label={t('cust.city')}><Input value={city} onChange={(e) => setCity(e.target.value)} /></Field>
        </div>
        <Field label={t('cust.gstin')}><Input value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} placeholder="08ABCDE1234F1Z5" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('cust.openingBalance')}><Input type="number" inputMode="numeric" value={opening || ''} onChange={(e) => setOpening(Number(e.target.value))} placeholder="0" /></Field>
          <Field label={t('cust.creditDays')}><Input type="number" inputMode="numeric" value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field>
        </div>
        {kind === 'customer' && (
          <Field label={t('cust.creditLimit')} hint={t('common.optional')}><Input type="number" inputMode="numeric" value={limit || ''} onChange={(e) => setLimit(Number(e.target.value))} placeholder="0" /></Field>
        )}
        <Field label={t('cust.notes')} hint={t('common.optional')}><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Sheet>
  )
}
