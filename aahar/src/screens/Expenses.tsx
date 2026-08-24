import { useState } from 'react'
import { useStore, newId } from '@/lib/data/store'
import type { PayMode } from '@/lib/types'
import { money } from '@/lib/money'
import { TODAY, fmtFull } from '@/lib/date'
import { userName } from '@/lib/select'
import { Card, PageHeader, Button, Stat, Sheet, Field, Input, Select, SectionTitle } from '@/components/ui'
import { Icon } from '@/components/icons'
import { payModes, payModeLabel } from '@/lib/status'

const CATEGORIES = ['Diesel / Fuel', 'Labour', 'Electricity', 'Maintenance', 'Packaging', 'Transport', 'Office', 'Repairs', 'Miscellaneous']

export function Expenses() {
  const { state, dispatch } = useStore()
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState(CATEGORIES[0])
  const [amount, setAmount] = useState(0)
  const [mode, setMode] = useState<PayMode>('cash')
  const [note, setNote] = useState('')

  const expenses = state.expenses.slice().sort((a, b) => (a.date < b.date ? 1 : -1))
  const today = expenses.filter((e) => e.date === TODAY).reduce((s, e) => s + e.amount, 0)
  const month = expenses.filter((e) => e.date.startsWith(TODAY.slice(0, 7))).reduce((s, e) => s + e.amount, 0)

  function save() {
    if (amount <= 0) return
    dispatch({ type: 'addExpense', expense: { id: newId('ex'), category, amount, mode, date: TODAY, note: note || undefined, enteredBy: state.currentUserId } })
    setAmount(0); setNote(''); setOpen(false)
  }

  return (
    <div>
      <PageHeader title="Expenses" hindi="खर्च" sub="Every rupee out — categorised, with who entered it."
        action={<Button className="hidden sm:inline-flex" onClick={() => setOpen(true)}><Icon.plus className="h-5 w-5" /> Add</Button>} />

      <div className="mb-4 grid grid-cols-2 gap-3">
        <Stat label="Today" value={money(today)} sub="expenses" tone="amber" icon="expenses" />
        <Stat label="This month" value={money(month)} sub={TODAY.slice(0, 7)} tone="gray" icon="reports" />
      </div>

      <SectionTitle>Recent expenses</SectionTitle>
      <Card className="divide-y divide-line">
        {expenses.map((e) => (
          <div key={e.id} className="flex items-center gap-3 px-4 py-3.5">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-canvas text-ink-500"><Icon.expenses className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold text-ink-900">{e.category}</div>
              <div className="text-xs text-ink-400">{fmtFull(e.date)} · {payModeLabel[e.mode]} · by {userName(state, e.enteredBy)}</div>
              {e.note && <div className="truncate text-xs text-ink-400">{e.note}</div>}
            </div>
            <div className="font-bold tabular text-rose-600">− {money(e.amount)}</div>
          </div>
        ))}
      </Card>

      <div className="no-print fixed bottom-24 right-4 z-30 sm:hidden">
        <button onClick={() => setOpen(true)} className="grid h-14 w-14 place-items-center rounded-full bg-brand-600 text-white shadow-lg"><Icon.plus className="h-6 w-6" /></button>
      </div>

      <Sheet open={open} onClose={() => setOpen(false)} title="Add expense" footer={<Button full size="lg" disabled={amount <= 0} onClick={save}>Save · {money(amount)}</Button>}>
        <div className="space-y-4">
          <Field label="Category · श्रेणी">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Amount · राशि">
            <Input type="number" inputMode="numeric" autoFocus min={0} value={amount || ''} onChange={(e) => setAmount(Number(e.target.value))} placeholder="0" />
          </Field>
          <Field label="Paid by">
            <div className="flex flex-wrap gap-2">
              {payModes.map((m) => (
                <button key={m} onClick={() => setMode(m)} className={`rounded-xl border px-3 py-2 text-sm font-semibold ${mode === m ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-line text-ink-500'}`}>{payModeLabel[m]}</button>
              ))}
            </div>
          </Field>
          <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Details, bill no., vehicle…" /></Field>
        </div>
      </Sheet>
    </div>
  )
}
