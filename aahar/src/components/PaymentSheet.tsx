import { useState } from 'react'
import { useStore, newId } from '@/lib/data/store'
import type { PayMode, Party } from '@/lib/types'
import { TODAY } from '@/lib/date'
import { money } from '@/lib/money'
import { outstanding } from '@/lib/select'
import { Sheet, Button, Field, Input, Select } from '@/components/ui'
import { payModes, payModeLabel } from '@/lib/status'

export function PaymentSheet({ open, onClose, fixedPartyId }: { open: boolean; onClose: () => void; fixedPartyId?: string }) {
  const { state, dispatch } = useStore()
  const [partyId, setPartyId] = useState(fixedPartyId ?? '')
  const [amount, setAmount] = useState(0)
  const [mode, setMode] = useState<PayMode>('upi')
  const [ref, setRef] = useState('')

  const party: Party | undefined = state.parties.find((p) => p.id === (fixedPartyId ?? partyId))
  const direction = party?.kind === 'supplier' ? 'out' : 'in'
  const bal = party ? outstanding(state, party.id) : 0

  function reset() {
    setPartyId(fixedPartyId ?? '')
    setAmount(0)
    setMode('upi')
    setRef('')
  }

  function save() {
    if (!party || amount <= 0) return
    dispatch({
      type: 'addPayment',
      payment: { id: newId('pm'), partyId: party.id, direction, amount, mode, date: TODAY, ref: ref || undefined, createdBy: state.currentUserId },
    })
    reset()
    onClose()
  }

  return (
    <Sheet
      open={open}
      onClose={() => { reset(); onClose() }}
      title={direction === 'out' ? 'Pay supplier' : 'Record payment'}
      footer={
        <Button full size="lg" disabled={!party || amount <= 0} onClick={save}>
          {direction === 'out' ? 'Save payment made' : 'Save payment received'} · {money(amount)}
        </Button>
      }
    >
      <div className="space-y-4">
        {!fixedPartyId && (
          <Field label="Party">
            <Select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
              <option value="">Select customer or supplier…</option>
              {state.parties.map((p) => (
                <option key={p.id} value={p.id}>{p.name} · {p.kind}</option>
              ))}
            </Select>
          </Field>
        )}
        {party && (
          <div className="rounded-xl bg-canvas px-4 py-3 text-sm">
            <span className="text-ink-500">Current {direction === 'out' ? 'payable' : 'outstanding'}: </span>
            <span className="font-bold tabular text-ink-900">{money(Math.abs(bal))}</span>
          </div>
        )}
        <Field label="Amount · राशि">
          <Input type="number" inputMode="numeric" autoFocus min={0} value={amount || ''} onChange={(e) => setAmount(Number(e.target.value))} placeholder="0" />
        </Field>
        {party && bal > 0 && (
          <button className="text-sm font-semibold text-brand-600" onClick={() => setAmount(Math.max(0, Math.round(bal)))}>
            Full amount ({money(Math.abs(bal))})
          </button>
        )}
        <Field label="Mode · माध्यम">
          <div className="flex flex-wrap gap-2">
            {payModes.map((m) => (
              <button key={m} onClick={() => setMode(m)} className={`rounded-xl border px-3 py-2 text-sm font-semibold ${mode === m ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-line text-ink-500'}`}>
                {payModeLabel[m]}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Reference (optional)" hint="UPI / cheque / NEFT no.">
          <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. UPI 4471" />
        </Field>
      </div>
    </Sheet>
  )
}
